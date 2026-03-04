# Setup Wizard Implementation Plan

## Overview

Replace the current in-app dependency installation flow with a dedicated first-run setup wizard. The wizard appears as a standalone window on initial launch (or when `--first-run` flag is passed) and guides users through essential configuration before they use the application.

## Goals

1. Provide a streamlined onboarding experience for new users
2. Consolidate initial setup tasks into a single, guided flow
3. Ensure dependencies are installed before the main app is used
4. Configure file type associations at setup time (Windows/Linux)
5. Allow re-running the wizard via command-line flag

## Wizard Steps

### Step 1: Welcome
- Application branding and welcome message
- Brief description of what the wizard will configure
- "Get Started" button to proceed

### Step 2: Server Port Configuration
- Explain what the media server port is used for
- Show current/default port (dynamically assigned or user-specified)
- Option to specify a fixed port or use automatic assignment
- Port availability validation

### Step 3: Dependencies
- Explain why FFmpeg and FluidSynth are needed
- Show current installation status for each
- Platform-specific installation options:
  - **Windows**: Download and install to app directory, or use winget
  - **macOS**: Homebrew installation (with command to copy)
  - **Linux**: Package manager commands (apt, dnf, pacman)
- Progress indicators during installation
- Skip option for users who want to install manually later

### Step 4: File Type Associations (Windows/Linux only)
- List of supported media file types grouped by category:
  - Audio: `.mp3`, `.flac`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.wma`, `.mid`, `.midi`
  - Video: `.mp4`, `.m4v`, `.mkv`, `.avi`, `.webm`, `.mov`
  - Playlists: `.opp`
- Select all / Deselect all controls
- Category-level toggles
- Explain that this makes ONIXPlayer the default app for selected types
- Skip option

### Step 5: Complete
- Summary of configured settings
- "Finish" button to close wizard and launch main app
- Option to "Don't show this again" (persisted to settings)

## Technical Design

### 1. First-Run Detection

```typescript
// In main.ts initialization
const isFirstRun = !settingsManager.get('setupCompleted', false);
const forceFirstRun = process.argv.includes('--first-run');

if (isFirstRun || forceFirstRun) {
  await showSetupWizard();
}
```

### 2. Wizard Window

Create a separate BrowserWindow for the wizard:

```typescript
private setupWizardWindow: BrowserWindow | null = null;

private async showSetupWizard(): Promise<void> {
  this.setupWizardWindow = new BrowserWindow({
    width: 700,
    height: 500,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'ONIXPlayer Setup',
    parent: this.window,  // Modal behavior
    modal: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load with query parameter to indicate wizard mode
  const url = `file://${path.join(__dirname, '../dist/onixlabs-media-player/browser/index.html')}?mode=setup-wizard`;
  await this.setupWizardWindow.loadURL(url);
  this.setupWizardWindow.show();

  // Wait for wizard completion
  return new Promise((resolve) => {
    this.setupWizardWindow?.on('closed', () => {
      this.setupWizardWindow = null;
      resolve();
    });
  });
}
```

### 3. Angular Component Structure

```
src/angular/components/setup-wizard/
├── setup-wizard.ts              # Main wizard container
├── setup-wizard.html
├── setup-wizard.scss
├── steps/
│   ├── welcome-step/
│   │   ├── welcome-step.ts
│   │   ├── welcome-step.html
│   │   └── welcome-step.scss
│   ├── port-step/
│   │   ├── port-step.ts
│   │   ├── port-step.html
│   │   └── port-step.scss
│   ├── dependencies-step/
│   │   ├── dependencies-step.ts
│   │   ├── dependencies-step.html
│   │   └── dependencies-step.scss
│   ├── associations-step/
│   │   ├── associations-step.ts
│   │   ├── associations-step.html
│   │   └── associations-step.scss
│   └── complete-step/
│       ├── complete-step.ts
│       ├── complete-step.html
│       └── complete-step.scss
```

### 4. IPC Handlers

Add new IPC handlers in main.ts:

```typescript
// Port configuration
ipcMain.handle('setup:getPort', () => settingsManager.get('serverPort'));
ipcMain.handle('setup:setPort', (_, port: number) => settingsManager.set('serverPort', port));
ipcMain.handle('setup:validatePort', async (_, port: number) => {
  // Check if port is available
  return await isPortAvailable(port);
});

// File associations (Windows/Linux only)
ipcMain.handle('setup:getAssociations', () => {
  // Return current file association state
});
ipcMain.handle('setup:setAssociations', async (_, associations: FileAssociation[]) => {
  if (process.platform === 'win32') {
    return await setWindowsFileAssociations(associations);
  } else if (process.platform === 'linux') {
    return await setLinuxFileAssociations(associations);
  }
  return { success: false, reason: 'Not supported on this platform' };
});

// Wizard completion
ipcMain.handle('setup:complete', () => {
  settingsManager.set('setupCompleted', true);
  this.setupWizardWindow?.close();
});

ipcMain.handle('setup:skip', () => {
  // Close without marking complete - will show again next launch
  this.setupWizardWindow?.close();
});
```

### 5. File Association Implementation

#### Windows (Registry)

```typescript
async function setWindowsFileAssociations(associations: FileAssociation[]): Promise<void> {
  const appPath = process.execPath;
  const appName = 'ONIXPlayer';

  for (const assoc of associations) {
    if (!assoc.enabled) continue;

    // Create file type class
    await execAsync(`reg add "HKCU\\Software\\Classes\\${assoc.extension}" /ve /d "${appName}.MediaFile" /f`);

    // Create handler
    await execAsync(`reg add "HKCU\\Software\\Classes\\${appName}.MediaFile\\shell\\open\\command" /ve /d "\\"${appPath}\\" \\"%1\\"" /f`);
  }

  // Notify shell of changes
  await execAsync('ie4uinit.exe -show');
}
```

#### Linux (xdg-mime)

```typescript
async function setLinuxFileAssociations(associations: FileAssociation[]): Promise<void> {
  const desktopFile = 'onixplayer.desktop';

  for (const assoc of associations) {
    if (!assoc.enabled) continue;

    // Map extension to MIME type
    const mimeType = extensionToMimeType(assoc.extension);
    await execAsync(`xdg-mime default ${desktopFile} ${mimeType}`);
  }
}

function extensionToMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.m4a': 'audio/mp4',
    '.m4v': 'video/mp4',
    '.aac': 'audio/aac',
    '.wma': 'audio/x-ms-wma',
    '.mid': 'audio/midi',
    '.midi': 'audio/midi',
    '.opp': 'application/x-onixplayer-playlist',
  };
  return mimeMap[ext] || 'application/octet-stream';
}
```

### 6. Preload API Extensions

```typescript
// Add to MediaPlayerAPI interface
readonly setupGetPort: () => Promise<number | null>;
readonly setupSetPort: (port: number) => Promise<void>;
readonly setupValidatePort: (port: number) => Promise<boolean>;
readonly setupGetAssociations: () => Promise<FileAssociation[]>;
readonly setupSetAssociations: (associations: FileAssociation[]) => Promise<SetupResult>;
readonly setupComplete: () => Promise<void>;
readonly setupSkip: () => Promise<void>;
readonly setupGetPlatform: () => string;  // For conditional UI
```

### 7. Settings Schema Update

```typescript
interface AppSettings {
  // Existing settings...

  // New setup-related settings
  setupCompleted: boolean;
  serverPort: number | null;  // null = auto-assign
  fileAssociations: {
    audio: boolean;
    video: boolean;
    playlists: boolean;
    // Or granular per-extension
  };
}
```

## UI/UX Design

### Wizard Layout

```
┌─────────────────────────────────────────────────────────┐
│  ┌─────┐                                                │
│  │ APP │   ONIXPlayer Setup                             │
│  │ICON │                                                │
│  └─────┘                                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ● Welcome  ○ Port  ○ Dependencies  ○ Files  ○ Done    │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│                                                         │
│                   [Step Content]                        │
│                                                         │
│                                                         │
│                                                         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                              [Back]  [Next / Finish]    │
└─────────────────────────────────────────────────────────┘
```

### Progress Indicator

- Horizontal step indicator at top showing all steps
- Current step highlighted
- Completed steps show checkmark
- Future steps appear dimmed

### Step Navigation

- "Back" button (disabled on first step)
- "Next" button (becomes "Finish" on last step)
- "Skip" link for optional steps (Dependencies, File Associations)
- Keyboard navigation: Enter for Next, Escape to close (with confirmation)

## Migration Path

### Phase 1: Add Wizard Infrastructure
1. Create wizard window management in main.ts
2. Add route/component detection for `?mode=setup-wizard`
3. Create basic wizard container component with step navigation
4. Add `setupCompleted` setting

### Phase 2: Implement Steps
1. Welcome step (static content)
2. Port configuration step (existing port logic)
3. Dependencies step (migrate from current DependencyService)
4. File associations step (new implementation)
5. Complete step (summary and finish)

### Phase 3: Platform-Specific Features
1. Implement Windows registry file associations
2. Implement Linux xdg-mime file associations
3. Conditionally hide associations step on macOS
4. Test on all platforms

### Phase 4: Polish
1. Add animations/transitions between steps
2. Improve error handling and recovery
3. Add "Run setup again" option in Settings
4. Update documentation

## Edge Cases

1. **Wizard closed without completing**: Show again on next launch
2. **Dependencies fail to install**: Allow retry or skip with warning
3. **Port already in use**: Show validation error, suggest alternatives
4. **File associations fail**: Show error but allow continuing
5. **--first-run with setupCompleted=true**: Still show wizard (flag overrides)
6. **App launched with file argument during first run**: Complete wizard first, then open file

## Testing Considerations

1. Unit tests for each step component
2. Integration tests for IPC handlers
3. E2E tests for full wizard flow
4. Platform-specific tests for file associations
5. Test --first-run flag behavior
6. Test wizard skip/cancel flows

## Open Questions

1. Should the wizard be skippable entirely, or require at least viewing each step?
2. Should we show a "What's New" section for existing users after updates?
3. Should file associations be reversible from within the app (Settings)?
4. Should we detect and import settings from other media players?
5. Should the port configuration offer a "test" button to verify connectivity?
