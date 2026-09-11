import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Ic from './Icons';
import { detectUserOS, type DetectedPlatform, type PlatformFamily } from '../utils/detectOS';

/** One artifact reported by `GET /downloads/` — a real file on disk. */
interface Artifact {
  name: string;
  size: number;
}

interface Platform {
  family: PlatformFamily;
  osName: string;
  icon: string;
  files: Artifact[];
}

const PLATFORMS: { family: PlatformFamily; osName: string; icon: string }[] = [
  { family: 'win', osName: 'Windows', icon: '🪟' },
  { family: 'mac', osName: 'macOS', icon: '🍎' },
  { family: 'linux', osName: 'Linux', icon: '🐧' },
];

/**
 * Which platform an artifact belongs to, from its filename. The names come
 * from `artifactName` in electron-builder.json (Conduit-Setup-1.0.0.exe,
 * Conduit-1.0.0-mac-arm64.dmg, Conduit-1.0.0-linux-x86_64.AppImage, …).
 */
function familyOf(name: string): PlatformFamily | null {
  const n = name.toLowerCase();
  if (n.endsWith('.exe') || n.includes('-win')) return 'win';
  if (n.endsWith('.dmg') || n.includes('-mac')) return 'mac';
  if (n.endsWith('.appimage') || n.endsWith('.deb') || n.endsWith('.rpm') || n.endsWith('.snap')) return 'linux';
  return null;
}

function labelOf(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('setup') && n.endsWith('.exe')) return 'Installer (.exe)';
  if (n.endsWith('.exe')) return 'Standalone Executable (.exe)';
  if (n.endsWith('.zip')) return 'Portable Archive (.zip)';
  if (n.endsWith('.dmg')) return 'Disk Image (.dmg)';
  if (n.endsWith('.appimage')) return 'AppImage (Universal)';
  if (n.endsWith('.deb')) return 'Debian / Ubuntu (.deb)';
  if (n.endsWith('.rpm')) return 'Fedora / RHEL (.rpm)';
  return name;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface DownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DownloadModal({ isOpen, onClose }: DownloadModalProps) {
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);
  const [platforms, setPlatforms] = useState<Platform[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    setDetected(detectUserOS());
  }, []);

  // Ask the server what it can actually serve. Advertising a build that was
  // never produced hands the user a renamed index.html.
  useEffect(() => {
    if (!isOpen || platforms) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/downloads/');
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const files: Artifact[] = Array.isArray(data?.files) ? data.files : [];
        if (cancelled) return;
        setPlatforms(
          PLATFORMS.map((p) => ({ ...p, files: files.filter((f) => familyOf(f.name) === p.family) })),
        );
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, platforms]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDownload = (filename: string) => {
    const link = document.createElement('a');
    link.href = `/downloads/${encodeURIComponent(filename)}`;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // The headline button offers the visitor's own OS — never a .exe to a Mac.
  const mine = detected?.family
    ? platforms?.find((p) => p.family === detected.family)
    : undefined;
  const primary = mine?.files.find((f) => !f.name.toLowerCase().endsWith('.zip')) || mine?.files[0];
  const anyBuilds = platforms?.some((p) => p.files.length > 0);

  const modalContent = (
    <div className="download-modal-overlay" onClick={onClose}>
      <div className="download-modal-container" data-tour="download-modal" onClick={(e) => e.stopPropagation()}>
        <button className="download-modal-close" onClick={onClose} aria-label="Close modal">
          <Ic.x size={16} />
        </button>

        <div className="download-section-header">
          <span className="step-num">GET CONDUIT</span>
          <h2 className="section-title">
            Run your multi-agent studio <span className="highlight-pill">locally</span>
          </h2>
          <p className="section-subtitle">
            Full native performance with real pseudo-terminals, local JSON persistence, and Supervisor approval gates.
          </p>

          {primary && detected && (
            <div className="primary-detected-download">
              <button className="primary-download-btn" onClick={() => handleDownload(primary.name)}>
                <span className="download-btn-icon">⬇</span>
                <div className="download-btn-content">
                  <span className="download-main-text">Download for {detected.label}</span>
                  <span className="download-sub-text">
                    {labelOf(primary.name)} · {formatSize(primary.size)} · Free &amp; Open Source
                  </span>
                </div>
              </button>
            </div>
          )}
        </div>

        {platforms && (
          <div className="download-matrix-grid">
            {platforms.map((p) => (
              <div
                key={p.family}
                className={`download-platform-card ${p.files.length ? 'platform-active' : 'platform-pending'}`}
              >
                <div className="platform-card-header">
                  <span className="platform-icon">{p.icon}</span>
                  <h3 className="platform-name">{p.osName}</h3>
                  <span className={`platform-status-badge ${p.files.length ? 'active' : 'coming_soon'}`}>
                    {p.files.length ? 'Available Now' : 'Not Built Yet'}
                  </span>
                </div>
                <div className="platform-formats-list">
                  {p.files.length === 0 ? (
                    <div className="download-format-row unavailable">
                      <div className="format-info">
                        <span className="format-label">No {p.osName} build on this server</span>
                        <span className="format-size">Build one with <code>npm run build:desktop</code> on {p.osName}</span>
                      </div>
                    </div>
                  ) : (
                    p.files.map((f) => (
                      <div key={f.name} className="download-format-row available">
                        <div className="format-info">
                          <span className="format-label">{labelOf(f.name)}</span>
                          <span className="format-size">{formatSize(f.size)}</span>
                        </div>
                        <button
                          className="format-download-btn active"
                          onClick={() => handleDownload(f.name)}
                          title={f.name}
                        >
                          Download
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {(loadError || (platforms && !anyBuilds)) && (
          <div className="download-footer-note">
            <span>
              No packaged build is available from this server yet. Clone the repo and run{' '}
              <code>npm install &amp;&amp; npm run build:desktop</code>, or grab a release from{' '}
              <a href="https://github.com/devprashant19/Conduit/releases" target="_blank" rel="noreferrer">
                GitHub
              </a>
              .
            </span>
          </div>
        )}

        <div className="download-footer-note">
          <span>Packaged with Electron &amp; node-pty · Open Source · MIT License</span>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
