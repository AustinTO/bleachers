import ExpoModulesCore
import Foundation

public final class ExpoMoqWebTransportModule: Module {
  private var clients: [String: Client] = [:]
  private var sessions: [String: Session] = [:]
  private var sendStreams: [String: SendStream] = [:]
  private var recvStreams: [String: RecvStream] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("ExpoMoqWebTransport")

    AsyncFunction("connect") { (
      url: String,
      protocols: [String],
      noCertificateVerification: Bool,
      maxIdleTimeoutSecs: Double?,
      keepAliveIntervalSecs: Double?
    ) async throws -> [String: Any?] in
      let config = ClientConfig(
        serverCertificateHashes: nil,
        noCertVerification: noCertificateVerification,
        congestionControl: .default,
        maxIdleTimeoutSecs: maxIdleTimeoutSecs,
        keepAliveIntervalSecs: keepAliveIntervalSecs
      )
      let client = try Client(config: config)
      let session = try await client.connectWithProtocols(url: url, protocols: protocols)
      let id = UUID().uuidString
      self.withLock {
        self.clients[id] = client
        self.sessions[id] = session
      }
      return [
        "sessionId": id,
        "protocol": session.protocol(),
        "maxDatagramSize": Double(session.maxDatagramSize())
      ]
    }

    AsyncFunction("close") { (sessionId: String, code: Int, reason: String) async throws in
      let session = try self.requireSession(sessionId)
      session.close(code: UInt32(code), reason: reason)
    }

    AsyncFunction("waitClosed") { (sessionId: String) async throws -> [String: Any] in
      let session = try self.requireSession(sessionId)
      await session.waitClosed()
      let info = session.closeInfo()
      return ["closeCode": Double(info.closeCode), "reason": info.reason]
    }

    AsyncFunction("releaseSession") { (sessionId: String) async throws in
      let client: Client? = self.withLock {
        self.sessions.removeValue(forKey: sessionId)
        return self.clients.removeValue(forKey: sessionId)
      }
      try client?.close(code: 0, reason: "")
    }

    AsyncFunction("openUni") { (sessionId: String) async throws -> String in
      self.storeSend(try await self.requireSession(sessionId).openUni())
    }

    AsyncFunction("openBi") { (sessionId: String) async throws -> [String: String] in
      let stream = try await self.requireSession(sessionId).openBi()
      return [
        "sendStreamId": self.storeSend(stream.send),
        "recvStreamId": self.storeRecv(stream.recv)
      ]
    }

    AsyncFunction("acceptUni") { (sessionId: String) async throws -> String in
      self.storeRecv(try await self.requireSession(sessionId).acceptUni())
    }

    AsyncFunction("acceptBi") { (sessionId: String) async throws -> [String: String] in
      let stream = try await self.requireSession(sessionId).acceptBi()
      return [
        "sendStreamId": self.storeSend(stream.send),
        "recvStreamId": self.storeRecv(stream.recv)
      ]
    }

    AsyncFunction("sendWrite") { (streamId: String, data: Data) async throws in
      try await self.requireSend(streamId).write(data: data)
    }

    AsyncFunction("sendFinish") { (streamId: String) async throws in
      try await self.requireSend(streamId).finish()
    }

    AsyncFunction("sendReset") { (streamId: String, code: Int) async throws in
      try self.requireSend(streamId).reset(errorCode: UInt32(code))
    }

    AsyncFunction("releaseSendStream") { (streamId: String) async in
      _ = self.withLock { self.sendStreams.removeValue(forKey: streamId) }
    }

    AsyncFunction("recvRead") { (streamId: String, maxBytes: Int) async throws -> Data in
      try await self.requireRecv(streamId).read(n: UInt64(maxBytes))
    }

    AsyncFunction("recvStop") { (streamId: String, code: Int) async throws in
      try self.requireRecv(streamId).stop(errorCode: UInt32(code))
    }

    AsyncFunction("releaseRecvStream") { (streamId: String) async in
      _ = self.withLock { self.recvStreams.removeValue(forKey: streamId) }
    }

    AsyncFunction("sendDatagram") { (sessionId: String, data: Data) async throws in
      try self.requireSession(sessionId).sendDatagram(data: data)
    }

    AsyncFunction("receiveDatagram") { (sessionId: String) async throws -> Data in
      try await self.requireSession(sessionId).receiveDatagram()
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock(); defer { lock.unlock() }
    return body()
  }

  private func storeSend(_ stream: SendStream) -> String {
    let id = UUID().uuidString
    withLock { sendStreams[id] = stream }
    return id
  }

  private func storeRecv(_ stream: RecvStream) -> String {
    let id = UUID().uuidString
    withLock { recvStreams[id] = stream }
    return id
  }

  private func requireSession(_ id: String) throws -> Session {
    if let value = withLock({ sessions[id] }) { return value }
    throw BridgeError.missing("session", id)
  }

  private func requireSend(_ id: String) throws -> SendStream {
    if let value = withLock({ sendStreams[id] }) { return value }
    throw BridgeError.missing("send stream", id)
  }

  private func requireRecv(_ id: String) throws -> RecvStream {
    if let value = withLock({ recvStreams[id] }) { return value }
    throw BridgeError.missing("receive stream", id)
  }
}

enum BridgeError: Error {
  case missing(String, String)
}
