// Window of the Sensemark app for Safari.
//
// Languages for free translation are downloaded here: macOS allows downloads
// only from an app window (.translationTask), not from the extension.
// The window also shows whether the extension is enabled in Safari.
//
// This file replaces ViewController.swift from Apple's template. The window is
// still created by Main.storyboard; SwiftUI draws the content.

import Cocoa
import SafariServices
import SwiftUI
import Translation
import WebKit

class ViewController: NSViewController {
    // Left over from Apple's template (wired in Main.storyboard), unused.
    @IBOutlet var webView: WKWebView?

    override func loadView() {
        let root: AnyView
        if #available(macOS 15.0, *) {
            root = AnyView(LanguagesView())
        } else {
            root = AnyView(
                Text("Free translation needs macOS 15 or later.\nOpenAI mode works either way.")
                    .multilineTextAlignment(.center)
                    .padding(40)
            )
        }
        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(x: 0, y: 0, width: 560, height: 640)
        view = hosting
    }
}

struct LanguageRow: Identifiable, Hashable {
    let id: String // language code, for example "en" or "ja"
    let name: String
    var installed: Bool
}

@available(macOS 15.0, *)
struct LanguagesView: View {
    @State private var rows: [LanguageRow] = []
    @State private var loading = true
    @State private var downloading: String?
    @State private var configuration: TranslationSession.Configuration?
    @State private var extensionEnabled: Bool?
    @State private var filter = ""

    private static let target = Locale.Language(identifier: "ru")

    private var extensionIdentifier: String {
        (Bundle.main.bundleIdentifier ?? "Sensemark") + ".Extension"
    }

    private var visibleRows: [LanguageRow] {
        let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return rows }
        return rows.filter { $0.name.lowercased().contains(query) || $0.id.lowercased().hasPrefix(query) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Sensemark")
                .font(.largeTitle.bold())
            Text("Translates selected text into Russian right in Safari.")
                .foregroundStyle(.secondary)

            extensionStatus

            Divider()

            Text("Languages for free translation")
                .font(.headline)
            Text("Download the languages you read. You only need to do this once: after that, translation works offline and the text never leaves your Mac.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField("Find a language", text: $filter)
                .textFieldStyle(.roundedBorder)

            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding()
            } else {
                List(visibleRows) { row in
                    HStack {
                        Text(row.name)
                        Spacer()
                        if row.installed {
                            Label("Downloaded", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else if downloading == row.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Button("Download") { download(row) }
                                .disabled(downloading != nil)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(24)
        .frame(minWidth: 520, minHeight: 600)
        .task {
            await refresh()
            await refreshExtensionState()
        }
        .translationTask(configuration) { session in
            // macOS shows its own sheet offering to download the language.
            do {
                try await session.prepareTranslation()
            } catch {
                // The user cancelled the download; just refresh the list.
            }
            await finishDownload()
        }
    }

    @ViewBuilder
    private var extensionStatus: some View {
        HStack(spacing: 10) {
            switch extensionEnabled {
            case .some(true):
                Label("The extension is on in Safari", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
            case .some(false):
                Label("The extension is off in Safari", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            case .none:
                Label("Checking whether the extension is on…", systemImage: "puzzlepiece.extension")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Safari Settings…") {
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionIdentifier) { _ in }
            }
        }
    }

    private func download(_ row: LanguageRow) {
        downloading = row.id
        let next = TranslationSession.Configuration(
            source: Locale.Language(identifier: row.id),
            target: Self.target
        )
        // Pressing again for the same pair must restart the task.
        if configuration?.source == next.source {
            configuration?.invalidate()
        } else {
            configuration = next
        }
    }

    @MainActor
    private func finishDownload() async {
        downloading = nil
        await refresh()
    }

    @MainActor
    private func refresh() async {
        let availability = LanguageAvailability()
        // Language names in the system language, like the rest of macOS.
        let display = Locale.current
        var seen = Set<String>()
        var result: [LanguageRow] = []
        for language in await availability.supportedLanguages {
            let id = language.minimalIdentifier
            guard language.languageCode?.identifier != "ru", seen.insert(id).inserted else { continue }
            let status = await availability.status(from: language, to: Self.target)
            guard status != .unsupported else { continue }
            let name = display.localizedString(forIdentifier: id) ?? id
            result.append(LanguageRow(id: id, name: name.prefix(1).uppercased() + name.dropFirst(), installed: status == .installed))
        }
        rows = result.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        loading = false
    }

    @MainActor
    private func refreshExtensionState() async {
        let identifier = extensionIdentifier
        let enabled: Bool? = await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: identifier) { state, _ in
                continuation.resume(returning: state?.isEnabled)
            }
        }
        extensionEnabled = enabled ?? false
    }
}
