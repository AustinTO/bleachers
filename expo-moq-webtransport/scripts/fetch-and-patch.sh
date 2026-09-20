#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$ROOT/.native-build/web-transport}"
TAG="web-transport-ffi-v0.1.2"

if [[ -f "$WORK/Cargo.toml" ]] && grep -q 'connect_with_protocols' "$WORK/rs/web-transport-ffi/src/client.rs"; then
  echo "Reusing patched native source at $WORK" >&2
  echo "$WORK"
  exit 0
fi

rm -rf "$WORK"
mkdir -p "$(dirname "$WORK")"

git clone --depth 1 --branch "$TAG" \
  https://github.com/moq-dev/web-transport.git "$WORK"

python3 - "$WORK" <<'PY'
from pathlib import Path
import sys

work = Path(sys.argv[1])

# ---------------------------------------------------------
# Cargo dependency
# ---------------------------------------------------------

cargo = work / "rs/web-transport-ffi/Cargo.toml"
s = cargo.read_text()

needle = 'rustls-native-certs = "0.8"\n'

if needle not in s:
    raise SystemExit("Could not find rustls-native-certs dependency")

if 'webpki-roots = "1"' not in s:
    s = s.replace(
        needle,
        needle + 'webpki-roots = "1"\n',
        1
    )

cargo.write_text(s)
print("patched Cargo.toml", file=sys.stderr)


# ---------------------------------------------------------
# client.rs
# ---------------------------------------------------------

client = work / "rs/web-transport-ffi/src/client.rs"
s = client.read_text()

# TLS fallback
cert_block = """            for cert in native.certs {
                let _ = roots.add(cert);
            }
"""

if cert_block not in s:
    raise SystemExit("Could not locate native certificate block")

s = s.replace(
    cert_block,
    cert_block + """
            // Android builds may occasionally expose no usable native CA roots.
            // Fall back to Mozilla roots rather than creating an empty store.
            if roots.is_empty() {
                roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            }
""",
    1
)

# Replace connect section using markers, NOT an exact body match.
start_marker = '    /// Open a WebTransport session to `url`.\n'
end_marker = '    /// Close the endpoint and all connections.\n'

start = s.find(start_marker)
if start < 0:
    raise SystemExit("Could not find connect() start marker")

end = s.find(end_marker, start)
if end < 0:
    raise SystemExit("Could not find connect() end marker")

new_connect = '''    /// Open a WebTransport session to `url`.
    pub async fn connect(&self, url: String) -> Result<Arc<Session>, WebTransportError> {
        self.connect_with_protocols(url, Vec::new()).await
    }

    /// Open a WebTransport session while offering application subprotocols.
    ///
    /// MoQT draft-16 uses the `moqt-16` WebTransport subprotocol.
    pub async fn connect_with_protocols(
        &self,
        url: String,
        protocols: Vec<String>,
    ) -> Result<Arc<Session>, WebTransportError> {
        let client = self.inner.clone();

        let parsed: url::Url = url
            .parse()
            .map_err(|e| WebTransportError::invalid(format!("invalid URL: {e}")))?;

        let request =
            web_transport_quinn::proto::ConnectRequest::new(parsed)
                .with_protocols(protocols);

        let handle = RUNTIME.spawn(async move {
            client
                .connect(request)
                .await
                .map_err(map_client_error)
        });

        let session = handle
            .await
            .map_err(|e| WebTransportError::Io(format!("connect task: {e}")))??;

        Ok(Session::new(session))
    }

'''

s = s[:start] + new_connect + s[end:]
client.write_text(s)

print("patched client.rs", file=sys.stderr)


# ---------------------------------------------------------
# session.rs
# ---------------------------------------------------------

session = work / "rs/web-transport-ffi/src/session.rs"
s = session.read_text()

# Add protocol() + close_info() immediately before max_datagram_size.
marker = '    /// Maximum payload size accepted by [`Self::send_datagram`].\n'

if marker not in s:
    raise SystemExit("Could not find Session max_datagram_size marker")

addition = '''    /// WebTransport application subprotocol selected by the server.
    ///
    /// Cloudflare MoQT draft-16 should return `moqt-16`.
    pub fn protocol(&self) -> Option<String> {
        self.clone_handle.protocol().map(str::to_owned)
    }

    /// Structured close information for the React Native facade.
    pub fn close_info(&self) -> SessionCloseInfo {
        match self
            .clone_handle
            .close_reason()
            .map(crate::error::map_session_error)
        {
            Some(WebTransportError::SessionClosedByPeer {
                code,
                reason,
                ..
            }) => SessionCloseInfo {
                close_code: code.unwrap_or(0),
                reason,
            },

            Some(WebTransportError::SessionClosedLocally) => SessionCloseInfo {
                close_code: 0,
                reason: String::new(),
            },

            Some(error) => SessionCloseInfo {
                close_code: 0,
                reason: error.to_string(),
            },

            None => SessionCloseInfo {
                close_code: 0,
                reason: String::new(),
            },
        }
    }

'''

s = s.replace(marker, addition + marker, 1)


# Add SessionCloseInfo record before RemoteAddress.
record_marker = '/// IP address + port of a remote peer.\n'

if record_marker not in s:
    raise SystemExit("Could not find RemoteAddress marker")

record = '''/// Close information returned to Kotlin/Swift.
#[derive(Debug, Clone, uniffi::Record)]
pub struct SessionCloseInfo {
    pub close_code: u64,
    pub reason: String,
}

'''

s = s.replace(record_marker, record + record_marker, 1)

session.write_text(s)
print("patched session.rs", file=sys.stderr)

print("ALL PATCHES APPLIED", file=sys.stderr)
PY

echo "$WORK"
