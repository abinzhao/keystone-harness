import Foundation
import Security

protocol CredentialStorage {
  func set(_ handle: String, _ secret: String) throws
  func resolve(_ handle: String) throws -> String?
  func delete(_ handle: String) throws
  func handles() throws -> [String]
}

struct CredentialFailure: Error {}

struct KeychainStorage: CredentialStorage {
  let service: String

  func query(_ handle: String? = nil) -> [String: Any] {
    var value: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
    ]
    if let handle { value[kSecAttrAccount as String] = handle }
    return value
  }

  func set(_ handle: String, _ secret: String) throws {
    let data = Data(secret.utf8)
    let status = SecItemUpdate(query(handle) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query(handle)
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CredentialFailure() }
    } else if status != errSecSuccess { throw CredentialFailure() }
  }

  func resolve(_ handle: String) throws -> String? {
    var item = query(handle)
    item[kSecReturnData as String] = true
    item[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(item as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data,
          let secret = String(data: data, encoding: .utf8) else { throw CredentialFailure() }
    return secret
  }

  func delete(_ handle: String) throws {
    let status = SecItemDelete(query(handle) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialFailure() }
  }

  func handles() throws -> [String] {
    var item = query()
    item[kSecReturnAttributes as String] = true
    item[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(item as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let attributes = result as? [[String: Any]] else { throw CredentialFailure() }
    return attributes.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
  }
}

final class MemoryStorage: CredentialStorage {
  var entries: [String: String] = [:]
  func set(_ handle: String, _ secret: String) { entries[handle] = secret }
  func resolve(_ handle: String) -> String? { entries[handle] }
  func delete(_ handle: String) { entries.removeValue(forKey: handle) }
  func handles() -> [String] { entries.keys.sorted() }
}

func operate(_ input: [String: String], storage: CredentialStorage) throws -> [String: Any] {
  guard let operation = input["operation"] else { throw CredentialFailure() }
  if operation == "list" {
    return ["ok": true, "handles": try storage.handles().map { ["handle": $0, "present": true] as [String: Any] }]
  }
  guard let handle = input["handle"],
        handle.range(of: "^[a-z0-9][a-z0-9._-]{1,63}$", options: .regularExpression) != nil else {
    throw CredentialFailure()
  }
  switch operation {
  case "set":
    guard let secret = input["secret"] else { throw CredentialFailure() }
    try storage.set(handle, secret)
  case "resolve":
    if let secret = try storage.resolve(handle) { return ["ok": true, "secret": secret] }
  case "delete":
    try storage.delete(handle)
  default: throw CredentialFailure()
  }
  return ["ok": true]
}

func output(_ value: [String: Any]) throws {
  FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value))
}

do {
  if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
    // No Security call in this path; build/runtime checks never touch real keys.
    let storage = MemoryStorage()
    _ = try operate(["operation": "set", "handle": "main", "secret": "fixture"], storage: storage)
    guard try operate(["operation": "resolve", "handle": "main"], storage: storage)["secret"] as? String == "fixture",
          try storage.handles() == ["main"] else { throw CredentialFailure() }
    _ = try operate(["operation": "delete", "handle": "main"], storage: storage)
    guard try storage.resolve("main") == nil else { throw CredentialFailure() }
    var refused = false
    do {
      _ = try operate(["operation": "set", "handle": "../escape", "secret": "fixture"], storage: storage)
    } catch is CredentialFailure { refused = true }
    guard refused else { throw CredentialFailure() }
    try output(["ok": true, "checks": 5, "backend": "memory"])
  } else {
    guard CommandLine.arguments.count == 1 else { throw CredentialFailure() }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 1_048_576,
          let input = try JSONSerialization.jsonObject(with: data) as? [String: String],
          let service = input["service"], service.hasPrefix("net.keystone.credentials.") else { throw CredentialFailure() }
    try output(operate(input, storage: KeychainStorage(service: service)))
  }
} catch {
  // Never include input, stderr from another process, or the secret in errors.
  FileHandle.standardError.write(Data("credential helper operation failed\n".utf8))
  exit(1)
}
