//! Media-independent Cloudflare draft-16 publisher, using the upstream protocol engine.
use std::sync::{Arc, Mutex};
use std::time::Duration;
use moq_transport::{coding::{KeyValuePairs, TrackNamespace, TupleField}, serve, session::Publisher};
use crate::{error::WebTransportError, ffi::RUNTIME};

fn error(e: impl std::fmt::Display) -> WebTransportError { WebTransportError::Io(e.to_string()) }

#[derive(uniffi::Object)]
pub struct MoqPublisher {
    publisher: Publisher,
    broadcast_name: String,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    failure: Arc<Mutex<Option<String>>>,
    _client: moq_native_ietf::quic::Client,
}

#[uniffi::export]
impl MoqPublisher {
    #[uniffi::constructor]
    pub async fn connect(relay_url: String, broadcast_name: String) -> Result<Arc<Self>, WebTransportError> {
        crate::ffi::spawn_abortable(async move {
            let url: url::Url = relay_url.parse().map_err(error)?;
            if url.scheme() != "https" { return Err(error("publisher requires HTTPS")); }
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let client = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[&rustls::version::TLS13]).map_err(error)?
                .with_root_certificates(roots).with_no_client_auth();
            let tls = moq_native_ietf::tls::Config { client, server: None, fingerprints: vec![] };
            let endpoint = moq_native_ietf::quic::Endpoint::new(
                moq_native_ietf::quic::Config::new("0.0.0.0:0".parse().unwrap(), None, tls).map_err(error)?
            ).map_err(error)?;
            let (transport, id, kind) = tokio::time::timeout(Duration::from_secs(20), endpoint.client.connect(&url, None))
                .await.map_err(error)?.map_err(error)?;
            let (session, publisher) = Publisher::connect_with_session_id(transport, moq_transport::session::SessionId::new(id), kind).await.map_err(error)?;
            let failure = Arc::new(Mutex::new(None));
            let failed = failure.clone();
            let task = RUNTIME.spawn(async move {
                let result = session.run().await;
                *failed.lock().unwrap() = Some(match result { Ok(()) => "session closed".into(), Err(e) => e.to_string() });
            });
            Ok(Arc::new(Self { publisher, broadcast_name, tasks: Mutex::new(vec![task]), failure, _client: endpoint.client }))
        }).await
    }

    pub async fn publish_track(&self, namespace: Vec<String>, name: String) -> Result<Arc<MoqTrack>, WebTransportError> {
        if namespace.join("/") != self.broadcast_name { return Err(error("track namespace must match backend broadcastName")); }
        self.check()?;
        let mut ns = TrackNamespace::new();
        for component in namespace { ns.add(TupleField::from_utf8(&component)); }
        let (writer, reader) = serve::Track::new(ns, name).produce();
        let writer = writer.subgroups().map_err(error)?;
        let mut publisher = self.publisher.clone();
        let failed = self.failure.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task = RUNTIME.spawn(async move {
            let result = async {
                let mut published = publisher.publish(reader, KeyValuePairs::default()).await.map_err(error)?;
                published.ok().await.map_err(error)?;
                let _ = ready_tx.send(());
                published.serve().await.map_err(error)
            }.await;
            if let Err(e) = result { *failed.lock().unwrap() = Some(e.to_string()); }
        });
        self.tasks.lock().unwrap().push(task);
        // Return only after PUBLISH_OK. The JS ready() promise has real relay-ack semantics.
        crate::ffi::spawn_abortable(async move {
            tokio::time::timeout(Duration::from_secs(15), ready_rx).await.map_err(error)?.map_err(error)
        }).await.map_err(|e| self.check().err().unwrap_or(e))?;
        Ok(Arc::new(MoqTrack { state: Mutex::new(TrackState { writer, subgroup: None }), failure: self.failure.clone() }))
    }

    pub fn check(&self) -> Result<(), WebTransportError> {
        if let Some(e) = self.failure.lock().unwrap().as_ref() { return Err(error(e)); }
        Ok(())
    }

    pub fn shutdown(&self) {
        *self.failure.lock().unwrap() = Some("publisher closed".into());
        for task in self.tasks.lock().unwrap().drain(..) { task.abort(); }
    }
}

impl Drop for MoqPublisher { fn drop(&mut self) { self.shutdown(); } }

struct TrackState {
    writer: serve::SubgroupsWriter,
    subgroup: Option<serve::SubgroupWriter>,
}

#[derive(uniffi::Object)]
pub struct MoqTrack { state: Mutex<TrackState>, failure: Arc<Mutex<Option<String>>> }

#[uniffi::export]
impl MoqTrack {
    /// Payload bytes are forwarded unchanged. Timestamp belongs to the media-layer envelope;
    /// keyframe opens a new independently deliverable MoQ group. Finished groups stay in the
    /// serve-layer ring (~15s) so a later AbsoluteStart subscribe can rewind from this publisher.
    pub fn send_object(&self, payload: Vec<u8>, timestamp_us: u64, keyframe: bool) -> Result<(), WebTransportError> {
        if let Some(e) = self.failure.lock().unwrap().as_ref() { return Err(error(e)); }
        let _ = timestamp_us;
        let mut state = self.state.lock().unwrap();
        if keyframe || state.subgroup.is_none() {
            // SubgroupsWriter owns the monotonically increasing group ID;
            // append's argument is the application priority, not a location.
            state.subgroup = Some(state.writer.append(0).map_err(error)?);
        }
        state.subgroup.as_mut().unwrap().write(payload.into()).map_err(error)
    }
}
