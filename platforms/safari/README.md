# Sensemark for Safari

The Safari extension for the Mac. It works the same as in Chrome, with one
difference: free mode translates with **Apple's translator** right on the Mac,
with no key and no internet. OpenAI mode is there too; the key goes into
settings.

You need macOS 26.4 or later and Xcode (free on the App Store). Nothing is
published; a regular Apple ID is enough.

## First install

1. **Download and unzip** `sensemark-safari-vX.Y.Z.zip` from
   [Releases](https://github.com/StrangerOfDawah/sensemark/releases/latest), for
   example into Downloads. From the source code it is built with
   `npm run safari:kit`.
2. **Open Terminal** and run (adjust the path if you unzipped elsewhere):
   ```
   cd ~/Downloads/sensemark-safari-v*/ && bash install.sh
   ```
   Use `bash install.sh`, not `./install.sh`: macOS does not run files received
   via AirDrop or from the internet directly ("operation not permitted").
   The script creates the project in `~/Sensemark-Safari` and opens it in Xcode.
   If Terminal says it cannot find `safari-web-extension-converter`, run
   `sudo xcode-select -s /Applications/Xcode.app` once and repeat the command.
3. **Signing in Xcode.** In the left sidebar, click the topmost item, the blue
   **Sensemark** project icon. In the **Targets** list in the middle, select
   **Sensemark** and then **Sensemark Extension**. For each, open
   **Signing & Capabilities** and choose your Apple ID (Personal Team) under
   **Team**. If the list is empty: **Xcode → Settings → Accounts → +** and sign
   in with your Apple ID.
4. **Run.** At the top left, the **Sensemark** scheme and **My Mac** must be
   selected. Press ▶ (or ⌘R). The Sensemark window with the language list opens.
5. **Turn the extension on.** In Safari open **Settings → Extensions**, tick
   Sensemark and allow it on all websites ("Always Allow on Every Website").
   If Sensemark is not listed: **Settings → Advanced** → "Show features for web
   developers", then **Settings → Developer** → "Allow unsigned extensions".
6. **Download languages.** In the Sensemark window, click "Download" next to the
   languages you read (English and others). macOS asks for confirmation once.
7. **Check the signature: this matters.** Quit Safari completely (⌘Q), open it
   again and look at **Settings → Extensions**.
   - Sensemark is on: the free Apple ID signature works, you are done.
   - Sensemark is gone or off: Safari does not accept this signature. Apple
     expects Safari extensions to come from the App Store, so outside the store
     there are three options: turn on "Allow unsigned extensions" after every
     Safari launch; an Apple Developer membership ($99 a year) and installing
     through TestFlight; or use Sensemark in Chrome, Edge or Arc, where no
     signature is needed.
8. **Done.** Select text with the mouse on any website, and the translation
   appears half a second later. You can also press ⌘⇧Y. Turn auto-translate off
   with the pause button on the card or in settings: the Sensemark icon in the
   Safari toolbar → the gear.

So the app does not disappear when Xcode cleans up, move it to Applications: in
Xcode choose **Product → Show Build Folder in Finder**, move
`Products/Debug/Sensemark.app` to Applications and open it from there once.

## Updating

Unzip the new archive, run `bash install.sh` again and press ▶ in Xcode. Signing
and settings are kept.

## Troubleshooting

- **The card says macOS needs to download a language once**: click the download
  button on the card. The Sensemark app opens; download that language there. The
  card continues the translation by itself.
- **The card says Apple's translator is unavailable**: check the macOS version
  (26.4+ is required) and that the Sensemark app has been launched at least once.
  You can also switch to OpenAI in settings.
- **An error in Xcode while building**: take a screenshot of the red error and
  send it to the developer.
