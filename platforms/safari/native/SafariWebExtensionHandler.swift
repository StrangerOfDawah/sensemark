// Native part of the Sensemark extension for Safari.
//
// background.js sends messages of the form {op: ..., ...}:
//   detect       detect the text's language (NaturalLanguage);
//   availability is the language downloaded for translating into Russian (Translation);
//   translate    translate text with Apple's on-device system translator;
//   openApp      open the Sensemark app, where languages are downloaded.
// The reply is always a dictionary with an "ok" key; the format matches what
// createAppleBridge in builtin-translator.js expects.

import AppKit
import NaturalLanguage
import SafariServices
import Translation
import os

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let request = NativeRequest(message)
        let box = ContextBox(context)

        Task {
            let reply = await NativeBridge.handle(request)
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            box.context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }
}

/// NSExtensionContext is not marked Sendable, so it is moved into the task explicitly.
private final class ContextBox: @unchecked Sendable {
    let context: NSExtensionContext
    init(_ context: NSExtensionContext) { self.context = context }
}

struct NativeRequest: Sendable {
    let op: String
    let text: String
    let source: String
    let target: String

    init(_ message: [String: Any]) {
        op = message["op"] as? String ?? ""
        text = message["text"] as? String ?? ""
        source = message["source"] as? String ?? ""
        target = message["target"] as? String ?? "ru"
    }
}

enum NativeBridge {
    private static let logger = Logger(subsystem: "Sensemark", category: "native")

    static func handle(_ request: NativeRequest) async -> [String: Any] {
        switch request.op {
        case "detect":
            return detect(request.text)
        case "availability":
            return await availability(source: request.source, target: request.target)
        case "translate":
            return await translate(request)
        case "openApp":
            let opened = await openApp()
            return opened ? ["ok": true] : ["ok": false, "code": "failed"]
        default:
            return ["ok": false, "code": "failed", "error": "unknown op: \(request.op)"]
        }
    }

    // MARK: - Language detection

    /// Same format as chrome.i18n.detectLanguage:
    /// {isReliable, languages: [{language, percentage}]}.
    static func detect(_ text: String) -> [String: Any] {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        let hypotheses = recognizer.languageHypotheses(withMaximum: 3).sorted { $0.value > $1.value }
        let languages: [[String: Any]] = hypotheses.map { hypothesis in
            ["language": hypothesis.key.rawValue, "percentage": Int((hypothesis.value * 100).rounded())]
        }
        // Any detector fails on one or two words, so such an answer is
        // marked unreliable, as Chrome does.
        let top = hypotheses.first?.value ?? 0
        let reliable = top >= 0.8 && text.count >= 20
        return ["ok": true, "isReliable": reliable, "languages": languages]
    }

    // MARK: - Language availability

    static func availability(source: String, target: String) async -> [String: Any] {
        guard #available(macOS 15.0, *) else {
            return ["ok": false, "code": "unavailable"]
        }
        let status = await LanguageAvailability().status(
            from: Locale.Language(identifier: source),
            to: Locale.Language(identifier: target)
        )
        switch status {
        case .installed:
            return ["ok": true, "status": "installed"]
        case .supported:
            return ["ok": true, "status": "supported"]
        case .unsupported:
            return ["ok": true, "status": "unsupported"]
        @unknown default:
            return ["ok": true, "status": "unsupported"]
        }
    }

    // MARK: - Translation

    static func translate(_ request: NativeRequest) async -> [String: Any] {
        // macOS can translate without a window (from an extension) since 26.4.
        guard #available(macOS 26.4, *) else {
            return ["ok": false, "code": "unavailable"]
        }
        do {
            let session = TranslationSession(
                installedSource: Locale.Language(identifier: request.source),
                target: Locale.Language(identifier: request.target),
                preferredStrategy: .lowLatency
            )
            let response = try await session.translate(request.text)
            return ["ok": true, "text": response.targetText]
        } catch {
            logger.error("translate failed: \(String(describing: error), privacy: .public)")
            // The language may have been removed in System Settings; offer to download it.
            let check = await availability(source: request.source, target: request.target)
            if check["status"] as? String == "supported" {
                return ["ok": false, "code": "needs-download"]
            }
            return ["ok": false, "code": "failed", "error": String(describing: error)]
        }
    }

    // MARK: - The Sensemark app

    /// The extension lives inside the app:
    /// Sensemark.app/Contents/PlugIns/Sensemark Extension.appex
    @MainActor
    static func openApp() async -> Bool {
        let appURL = Bundle.main.bundleURL
            .deletingLastPathComponent() // PlugIns
            .deletingLastPathComponent() // Contents
            .deletingLastPathComponent() // Sensemark.app
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        do {
            _ = try await NSWorkspace.shared.openApplication(at: appURL, configuration: configuration)
            return true
        } catch {
            logger.error("open app failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }
}
