/**
 * KeystoneWindow — the native macOS thin window for the desktop shell.
 *
 * A deliberately small WKWebView host (ADR-0008, Decision H). It does exactly
 * four jobs and nothing else:
 *
 *  1. Open one titled, resizable macOS window pointing at the shell origin URL.
 *  2. Die when the window closes (the Node shell supervises this process: its
 *     exit is the signal to tear down the supervised runtime child).
 *  3. Give the web view a normal keyboard life: a standard menu bar whose
 *     Edit items route Cmd-X/C/V/A through the responder chain into web
 *     text fields, and Cmd-+/−/0 page zoom.
 *  4. Refuse to become smaller than the narrow-window breakpoint (the page
 *     itself collapses to one column below it; ADR-0008 Decision G).
 *
 * It holds no token, no config, and no task state — it only displays the URL
 * the Node shell passes on its command line.
 *
 * Build:
 *   swiftc src-native/KeystoneWindow.swift -o bin/keystone-window \
 *     -framework Cocoa -framework WebKit -O
 */

import Cocoa
import WebKit

/** WebView subclass: page zoom on Cmd-+/−/0, passed through otherwise. */
final class KeystoneWebView: WKWebView {
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard event.modifierFlags.contains(.command), !event.modifierFlags.contains(.shift) else {
      return super.performKeyEquivalent(with: event)
    }
    switch event.charactersIgnoringModifiers {
    case "=", "+":
      zoomPage(factor: 1.1)
      return true
    case "-", "_":
      zoomPage(factor: 0.9)
      return true
    case "0":
      self.pageZoom = 1.0
      return true
    default:
      return super.performKeyEquivalent(with: event)
    }
  }

  private func zoomPage(factor: Double) {
    let next = min(2.0, max(0.5, self.pageZoom * factor))
    self.pageZoom = next
  }
}

/**
 * Delegate kept alive in a local (strong) variable: WKWebView's
 * navigationDelegate and NSWindow's delegate are weak, so without this the
 * object would be deallocated immediately and windowWillClose would never fire.
 */
final class WindowDelegate: NSObject, NSWindowDelegate, WKNavigationDelegate {
  let shellURL: URL
  init(shellURL: URL) { self.shellURL = shellURL }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let destination = navigationAction.request.url,
          sameOrigin(destination, shellURL) else {
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func windowWillClose(_ notification: Notification) {
    // The user closed the only window: the shell treats this process exiting
    // as "the user closed Keystone" and tears the runtime child down.
    exit(0)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // The web content process crashed; a zombie window is worse than none.
    exit(2)
  }
}

/** A standard menu bar. Only the Edit menu matters functionally: its standard
 *  selectors route through the responder chain into the focused web view so
 *  Cmd-Z/X/C/V/A work in onboarding inputs (a bare window with no Edit menu
 *  silently breaks paste in WKWebView). */
func buildMainMenu(app: NSApplication, bridge: NativeControls) {
  let mainMenu = NSMenu()
  app.mainMenu = mainMenu

  // App menu
  let appMenuItem = NSMenuItem()
  mainMenu.addItem(appMenuItem)
  let appMenu = NSMenu()
  appMenuItem.submenu = appMenu
  appMenu.addItem(NSMenuItem(title: "About Keystone", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
  let settings = NSMenuItem(title: "Settings...", action: #selector(NativeControls.showSettings(_:)), keyEquivalent: ",")
  settings.target = bridge
  appMenu.addItem(settings)
  appMenu.addItem(.separator())
  appMenu.addItem(NSMenuItem(title: "Hide Keystone", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
  appMenu.addItem(NSMenuItem(title: "Quit Keystone", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

  // Edit menu — standard selectors, target nil → responder chain → web view.
  let editMenuItem = NSMenuItem()
  mainMenu.addItem(editMenuItem)
  let editMenu = NSMenu(title: "Edit")
  editMenuItem.submenu = editMenu
  editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
  editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
  editMenu.addItem(.separator())
  editMenu.addItem(NSMenuItem(title: "Cut", action: Selector(("cut:")), keyEquivalent: "x"))
  editMenu.addItem(NSMenuItem(title: "Copy", action: Selector(("copy:")), keyEquivalent: "c"))
  editMenu.addItem(NSMenuItem(title: "Paste", action: Selector(("paste:")), keyEquivalent: "v"))
  editMenu.addItem(NSMenuItem(title: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a"))

  // Window menu
  let windowMenuItem = NSMenuItem()
  mainMenu.addItem(windowMenuItem)
  let windowMenu = NSMenu(title: "Window")
  windowMenuItem.submenu = windowMenu
  windowMenu.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
  windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
  windowMenu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
}

func sameOrigin(_ left: URL, _ right: URL) -> Bool {
  left.scheme == right.scheme && left.host == right.host && left.port == right.port
}

func isShellURL(_ url: URL) -> Bool {
  url.scheme == "http" && url.host == "127.0.0.1" && url.port != nil &&
    url.user == nil && url.password == nil
}

func folderPanel(prompt: String) -> NSOpenPanel {
  let panel = NSOpenPanel()
  panel.message = prompt
  panel.canChooseDirectories = true
  panel.canChooseFiles = false
  panel.allowsMultipleSelection = false
  panel.canCreateDirectories = false
  return panel
}

func folderResult(_ response: NSApplication.ModalResponse, url: URL?) -> [String: Any] {
  guard response == .OK, let url else { return ["supported": true, "cancelled": true] }
  return ["supported": true, "path": url.path]
}

let nativeScript = """
Object.defineProperty(window, 'keystoneNative', {value: Object.freeze({
  pickFolder: () => window.webkit.messageHandlers.keystone.postMessage({operation: 'pickFolder'})
}), writable: false, configurable: false});
"""

final class NativeControls: NSObject, WKScriptMessageHandlerWithReply {
  let shellURL: URL
  weak var webView: WKWebView?
  weak var window: NSWindow?
  var activePanel: NSOpenPanel?

  init(shellURL: URL) { self.shellURL = shellURL }

  @objc func showSettings(_ sender: Any?) {
    guard let webView, let current = webView.url, sameOrigin(current, shellURL) else { return }
    webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('keystone:settings'))", completionHandler: nil)
  }

  func userContentController(_ userContentController: WKUserContentController,
                             didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == shellURL.scheme,
          origin.host == shellURL.host, origin.port == shellURL.port,
          let body = message.body as? [String: String], body["operation"] == "pickFolder",
          let window else {
      replyHandler(nil, "native request refused")
      return
    }
    guard activePanel == nil else {
      replyHandler(["supported": true, "error": "folder selection already active"], nil)
      return
    }
    let panel = folderPanel(prompt: "Choose a project folder")
    activePanel = panel
    panel.beginSheetModal(for: window) { [weak self] response in
      self?.activePanel = nil
      replyHandler(folderResult(response, url: panel.url), nil)
    }
  }
}

func output(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value) {
    FileHandle.standardOutput.write(data)
  } else { exit(1) }
}

if CommandLine.arguments.contains("--self-test") {
  let app = NSApplication.shared
  app.setActivationPolicy(.prohibited)
  let url = URL(string: "http://127.0.0.1:9000/")!
  let bridge = NativeControls(shellURL: url)
  buildMainMenu(app: app, bridge: bridge)
  let settings = app.mainMenu?.items.first?.submenu?.items.first { $0.keyEquivalent == "," }
  let panel = folderPanel(prompt: "Fixture")
  guard settings?.target === bridge, settings?.action == #selector(NativeControls.showSettings(_:)),
        panel.canChooseDirectories, !panel.canChooseFiles, !panel.allowsMultipleSelection,
        !panel.canCreateDirectories, isShellURL(url), !isShellURL(URL(string: "https://remote.test")!),
        !sameOrigin(url, URL(string: "http://127.0.0.1:9001/")!),
        folderResult(.cancel, url: nil)["cancelled"] as? Bool == true,
        folderResult(.OK, url: URL(fileURLWithPath: "/fixture"))["path"] as? String == "/fixture",
        nativeScript.contains("pickFolder") else { exit(1) }
  output(["ok": true, "checks": 6, "backend": "AppKit", "gui": false])
  exit(0)
}

if CommandLine.arguments.contains("--pick-folder") {
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  let args = CommandLine.arguments
  let promptIndex = args.firstIndex(of: "--prompt")
  let prompt = promptIndex.flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "Choose a project folder"
  let panel = folderPanel(prompt: prompt)
  app.activate(ignoringOtherApps: true)
  output(folderResult(panel.runModal(), url: panel.url))
  exit(0)
}

var args = CommandLine.arguments
var urlString: String?
var title = "Keystone"
var width = 1200.0
var height = 800.0

var i = 1
while i < args.count {
  switch args[i] {
  case "--title":
    i += 1
    if i < args.count { title = args[i] }
  case "--width":
    i += 1
    if i < args.count, let w = Double(args[i]) { width = w }
  case "--height":
    i += 1
    if i < args.count, let h = Double(args[i]) { height = h }
  default:
    if urlString == nil { urlString = args[i] }
  }
  i += 1
}

guard let urlString, let url = URL(string: urlString), isShellURL(url) else {
  FileHandle.standardError.write("usage: KeystoneWindow <url> [--title t] [--width w] [--height h]\n".data(using: .utf8)!)
  exit(64)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let bridge = NativeControls(shellURL: url)
buildMainMenu(app: app, bridge: bridge)

let rect = NSRect(x: 0, y: 0, width: width, height: height)
let window = NSWindow(
  contentRect: rect,
  styleMask: [.titled, .closable, .miniaturizable, .resizable],
  backing: .buffered,
  defer: false
)
// Narrow-window floor: below this the page collapses (CSS @media) anyway; we
// never let the window get so narrow that the simple-mode composer is unusable.
window.minSize = NSSize(width: 360, height: 480)
window.title = title
window.center()

let delegate = WindowDelegate(shellURL: url)
let config = WKWebViewConfiguration()
config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "keystone")
config.userContentController.addUserScript(WKUserScript(source: nativeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
let webView = KeystoneWebView(frame: window.contentView!.bounds, configuration: config)
bridge.webView = webView
bridge.window = window
webView.autoresizingMask = [.width, .height]
webView.allowsBackForwardNavigationGestures = true
// Tab reaches links/form controls when Full Keyboard Access is on; the Edit
// menu supplies the standard editing shortcuts inside web text fields.
webView.navigationDelegate = delegate
window.contentView?.addSubview(webView)
window.delegate = delegate

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
webView.load(URLRequest(url: url))

app.run()
