import Foundation

// Newline-delimited JSON over margind's Unix socket. Reconnects every couple of seconds
// while margind isn't there; subscribes on every connect.
final class DaemonClient: @unchecked Sendable {
  let path: String
  var onPush: (@MainActor (Push) -> Void)?
  var onConnected: (@MainActor (Bool) -> Void)?

  private let lock = NSLock()
  private var fd: Int32 = -1

  init(path: String) {
    self.path = path
  }

  static func defaultPath() -> String {
    let home = ProcessInfo.processInfo.environment["MARGIN_HOME"]
      ?? (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Margin")
    return (home as NSString).appendingPathComponent("margind.sock")
  }

  func start() {
    let thread = Thread { [weak self] in self?.run() }
    thread.name = "margin.daemon"
    thread.start()
  }

  func send(_ request: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(request),
      var data = try? JSONSerialization.data(withJSONObject: request)
    else { return }
    data.append(0x0a)
    lock.lock()
    defer { lock.unlock() }
    guard fd >= 0 else { return }
    data.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let written = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if written <= 0 { break }
        offset += written
      }
    }
  }

  private func connectSocket() -> Int32? {
    let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard socket >= 0 else { return nil }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
      close(socket)
      return nil
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if result != 0 {
      close(socket)
      return nil
    }
    return socket
  }

  private func notify(_ connected: Bool) {
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated { self?.onConnected?(connected) }
    }
  }

  private func run() {
    var wasConnected: Bool?
    while true {
      guard let socket = connectSocket() else {
        if wasConnected != false { notify(false) }
        wasConnected = false
        Thread.sleep(forTimeInterval: 1.5)
        continue
      }
      lock.lock()
      fd = socket
      lock.unlock()
      wasConnected = true
      notify(true)
      send(["op": "subscribe"])

      var pending = Data()
      var buffer = [UInt8](repeating: 0, count: 64 * 1024)
      while true {
        let count = read(socket, &buffer, buffer.count)
        if count <= 0 { break }
        pending.append(contentsOf: buffer[0..<count])
        while let newline = pending.firstIndex(of: 0x0a) {
          let line = pending[pending.startIndex..<newline]
          pending.removeSubrange(pending.startIndex...newline)
          if let push = Push.decode(Data(line)) {
            DispatchQueue.main.async { [weak self] in
              MainActor.assumeIsolated { self?.onPush?(push) }
            }
          }
        }
        if pending.count > 4 * 1024 * 1024 { break }
      }
      lock.lock()
      close(socket)
      fd = -1
      lock.unlock()
      notify(false)
      wasConnected = false
      Thread.sleep(forTimeInterval: 1)
    }
  }
}
