//! Loopback HTTP media server.
//!
//! Every audio byte the webview plays comes through here, for local files and for
//! resolved YouTube streams alike. That single pipeline is what makes the Web Audio
//! analyser work: `createMediaElementSource()` yields silence for cross-origin media
//! without CORS, and Tauri's `asset://` protocol re-reads files from byte 0 on every
//! Range request (tauri#6375), which makes seeking unusable for large files.
//!
//! Security posture:
//!   * binds 127.0.0.1 only, on an OS-assigned ephemeral port
//!   * every request must carry a per-session token
//!   * files are addressed by opaque hex ids from an in-memory map; no caller-supplied
//!     path ever reaches the filesystem

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use tiny_http::{Header, Method, Response, Server, StatusCode};

#[derive(Clone)]
pub struct MediaServer {
    port: u16,
    token: String,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl MediaServer {
    pub fn start() -> io::Result<Self> {
        let server =
            Server::http("127.0.0.1:0").map_err(|e| io::Error::other(e.to_string()))?;

        let port = match server.server_addr().to_ip() {
            Some(addr) => addr.port(),
            None => return Err(io::Error::other("media server bound to a non-IP address")),
        };

        let mut raw = [0u8; 24];
        getrandom::fill(&mut raw).map_err(io::Error::other)?;
        let token = to_hex(&raw);

        let media = Self { port, token, files: Arc::new(Mutex::new(HashMap::new())) };
        let worker = media.clone();

        thread::Builder::new()
            .name("malice-media".into())
            .spawn(move || worker.serve(server))?;

        Ok(media)
    }

    /// Register a file on disk and return the opaque id used to address it.
    pub fn register(&self, path: PathBuf) -> String {
        let mut files = self.files.lock().expect("media map poisoned");

        // Idempotent: re-registering the same path reuses its id.
        if let Some((id, _)) = files.iter().find(|(_, p)| **p == path) {
            return id.clone();
        }

        let mut raw = [0u8; 16];
        if getrandom::fill(&mut raw).is_err() {
            // Fall back to a deterministic-but-unique id; the token is still required.
            let id = format!("{:x}", (path.as_os_str().len() as u128) << 64 | files.len() as u128);
            files.insert(id.clone(), path);
            return id;
        }
        let id = to_hex(&raw);
        files.insert(id.clone(), path);
        id
    }

    pub fn url_for(&self, id: &str) -> String {
        format!("http://127.0.0.1:{}/m/{}/{}", self.port, self.token, id)
    }

    /// Drop ids whose files no longer exist.
    ///
    /// Cache eviction calls this after a successful unlink, so a URL that was handed to
    /// the webview earlier returns 404 instead of a ghost response for a deleted file.
    pub fn forget_paths(&self, paths: &[PathBuf]) {
        if paths.is_empty() {
            return;
        }
        let mut files = self.files.lock().expect("media map poisoned");
        files.retain(|_, registered| !paths.iter().any(|candidate| candidate == registered));
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    fn serve(&self, server: Server) {
        for request in server.incoming_requests() {
            if let Err(err) = self.handle(request) {
                eprintln!("[media] {err}");
            }
        }
    }

    fn handle(&self, request: tiny_http::Request) -> io::Result<()> {
        if request.method() != &Method::Get && request.method() != &Method::Head {
            return respond(request, StatusCode(405), vec![]);
        }

        let path = request.url().split('?').next().unwrap_or("").to_string();
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if parts.len() != 3 || parts[0] != "m" {
            return respond(request, StatusCode(404), vec![]);
        }
        if !constant_time_eq(parts[1], &self.token) {
            return respond(request, StatusCode(401), vec![]);
        }

        let id = parts[2];
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return respond(request, StatusCode(400), vec![]);
        }

        let file_path = {
            let files = self.files.lock().expect("media map poisoned");
            match files.get(id) {
                Some(p) => p.clone(),
                None => return respond(request, StatusCode(404), vec![]),
            }
        };

        let mut file = match File::open(&file_path) {
            Ok(f) => f,
            Err(_) => return respond(request, StatusCode(404), vec![]),
        };
        let total = file.metadata()?.len();

        let range = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Range"))
            .and_then(|h| parse_range(h.value.as_str(), total));

        let content_type = content_type_for(&file_path);
        let base_headers = vec![
            header("Content-Type", content_type),
            header("Accept-Ranges", "bytes"),
            header("Cache-Control", "no-store"),
            // Required so the webview may hand these bytes to Web Audio.
            header("Access-Control-Allow-Origin", "*"),
            header(
                "Access-Control-Expose-Headers",
                "Content-Length, Content-Range, Accept-Ranges",
            ),
        ];

        let (status, start, len) = match range {
            Some((start, end)) => {
                file.seek(SeekFrom::Start(start))?;
                (StatusCode(206), start, end - start + 1)
            }
            None => (StatusCode(200), 0, total),
        };

        let mut headers = base_headers;
        if status.0 == 206 {
            headers.push(header(
                "Content-Range",
                &format!("bytes {start}-{}/{total}", start + len - 1),
            ));
        }
        headers.push(header("Content-Length", &len.to_string()));

        if request.method() == &Method::Head {
            return respond(request, status, headers);
        }

        let body = file.take(len);
        let response = Response::new(status, headers, body, Some(len as usize), None);
        request.respond(response)
    }
}

/// `bytes=start-end`, `bytes=start-`, and suffix ranges are supported.
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // multi-range: serve the whole file instead
    }
    let (start_s, end_s) = spec.split_once('-')?;

    if start_s.is_empty() {
        let suffix: u64 = end_s.trim().parse().ok()?;
        if suffix == 0 || total == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some((start, total - 1));
    }

    let start: u64 = start_s.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_s.trim().is_empty() {
        total - 1
    } else {
        end_s.trim().parse::<u64>().ok()?.min(total - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn content_type_for(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("m4a") | Some("mp4") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("webm") => "audio/webm",
        Some("aac") => "audio/aac",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn respond(request: tiny_http::Request, status: StatusCode, headers: Vec<Header>) -> io::Result<()> {
    let mut response = Response::empty(status);
    for h in headers {
        response.add_header(h);
    }
    response.add_header(header("Access-Control-Allow-Origin", "*"));
    request.respond(response).map(|_| ()).map_err(io::Error::other)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_clamped_and_validated() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=9-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("nonsense", 1000), None);
    }

    #[test]
    fn token_compare_is_length_aware() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    #[test]
    fn suffix_range_of_empty_file_is_none() {
        assert_eq!(parse_range("bytes=-10", 0), None);
    }

    fn http_get(port: u16, path: &str, range: Option<&str>) -> (u16, String, Vec<u8>) {
        use std::io::Write;
        use std::net::TcpStream;

        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        if let Some(range) = range {
            request.push_str(&format!("Range: {range}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let status = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, head, raw[split..].to_vec())
    }

    #[test]
    fn headers_are_media_friendly() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("malice-hdr-{}.m4a", std::process::id()));
        std::fs::write(&path, vec![0u8; 4096]).unwrap();

        let server = MediaServer::start().unwrap();
        let id = server.register(path.clone());
        let url = format!("/m/{}/{id}", server.token);

        let (status, head, body) = http_get(server.port, &url, None);
        let lower = head.to_ascii_lowercase();
        assert_eq!(status, 200, "{head}");
        assert_eq!(body.len(), 4096);
        assert_eq!(lower.matches("content-length:").count(), 1, "duplicate content-length: {head}");
        assert!(!lower.contains("transfer-encoding: chunked"), "chunked breaks duration: {head}");
        assert!(lower.contains("accept-ranges: bytes"), "{head}");
        assert!(lower.contains("cache-control: no-store"), "{head}");

        let (status, head, body) = http_get(server.port, &url, Some("bytes=0-"));
        let lower = head.to_ascii_lowercase();
        assert_eq!(status, 206, "{head}");
        assert_eq!(body.len(), 4096);
        assert_eq!(lower.matches("content-length:").count(), 1, "{head}");
        assert_eq!(lower.matches("content-range:").count(), 1, "{head}");

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn forget_paths_makes_an_existing_url_404() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("malice-forget-{}.m4a", std::process::id()));
        std::fs::write(&path, b"audio bytes").unwrap();

        let server = MediaServer::start().unwrap();
        let id = server.register(path.clone());
        let url = format!("/m/{}/{id}", server.token);

        let (status, _, _) = http_get(server.port, &url, None);
        assert_eq!(status, 200);

        server.forget_paths(&[path.clone()]);

        let (status, _, _) = http_get(server.port, &url, None);
        assert_eq!(status, 404, "an evicted file must not be served through a stale id");

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn serves_ranges_with_cors_and_rejects_bad_tokens() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("malice-test-{}.wav", std::process::id()));
        std::fs::write(&path, b"RIFFdata-for-tests").unwrap();

        let server = MediaServer::start().unwrap();
        let id = server.register(path.clone());

        let (status, head, body) = http_get(server.port, &format!("/m/{}/{id}", server.token), Some("bytes=0-3"));
        assert_eq!(status, 206, "{head}");
        assert!(head.to_ascii_lowercase().contains("access-control-allow-origin: *"), "{head}");
        assert!(head.to_ascii_lowercase().contains("accept-ranges: bytes"), "{head}");
        assert_eq!(body, b"RIFF");

        let (status, _, _) = http_get(server.port, &format!("/m/{}/{id}", "0".repeat(48)), None);
        assert_eq!(status, 401);

        let (status, _, _) = http_get(server.port, &format!("/m/{}/..%2f..%2fetc", server.token), None);
        assert_eq!(status, 400);

        std::fs::remove_file(path).ok();
    }
}
