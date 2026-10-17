import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const app = new URL('.cache/preview/MarginPreview.app/Contents/', root);
const build = new URL('.cache/swift-ui/debug/', root);
await mkdir(new URL('MacOS/', app), { recursive: true });
await copyFile(new URL('MarginPreview', build), new URL('MacOS/MarginPreview', app));
await cp(new URL('MarginPreview_MarginPreview.bundle/', build), new URL('../MarginPreview_MarginPreview.bundle/', app), { recursive: true });
await writeFile(new URL('Info.plist', app), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.example.margin.preview</string>
<key>CFBundleName</key><string>MarginPreview</string>
<key>CFBundleDisplayName</key><string>margin Preview</string>
<key>CFBundleExecutable</key><string>MarginPreview</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
console.log('Packaged .cache/preview/MarginPreview.app (fictional-data UI preview)');
