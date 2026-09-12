import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Ic from './Icons';
import { detectUserOS, type DetectedPlatform } from '../utils/detectOS';

interface DownloadFormat {
  label: string;
  file: string;
  size: string;
  available: boolean;
  btnLabel?: string;
}

interface PlatformConfig {
  platform: string;
  osName: string;
  icon: (props: { size?: number }) => JSX.Element;
  status: 'active' | 'coming_soon';
  badge: string;
  formats: DownloadFormat[];
}

const DOWNLOAD_OPTIONS: PlatformConfig[] = [
  {
    platform: 'win',
    osName: 'Windows',
    icon: (p) => <Ic.windows size={p.size || 20} />,
    status: 'active',
    badge: 'Available Now',
    formats: [
      {
        label: 'Standalone Executable (.exe)',
        file: 'Conduit.exe',
        size: '234 MB',
        available: true,
        btnLabel: 'Download .exe',
      },
      {
        label: 'Portable Archive (.zip)',
        file: 'Conduit-1.0.0-win.zip',
        size: '543 MB',
        available: true,
        btnLabel: 'Download .zip',
      },
    ],
  },
  {
    platform: 'mac',
    osName: 'macOS',
    icon: (p) => <Ic.apple size={p.size || 20} />,
    status: 'coming_soon',
    badge: 'Coming Soon',
    formats: [
      {
        label: 'Apple Silicon (M1/M2/M3/M4)',
        file: 'Conduit-1.0.0-arm64.dmg',
        size: 'In development',
        available: false,
      },
      {
        label: 'Intel x64 (.dmg)',
        file: 'Conduit-1.0.0-x64.dmg',
        size: 'In development',
        available: false,
      },
    ],
  },
  {
    platform: 'linux',
    osName: 'Linux',
    icon: (p) => <Ic.linux size={p.size || 20} />,
    status: 'coming_soon',
    badge: 'Coming Soon',
    formats: [
      {
        label: 'AppImage (Universal)',
        file: 'Conduit-1.0.0.AppImage',
        size: 'In development',
        available: false,
      },
      {
        label: 'Debian / Ubuntu (.deb)',
        file: 'conduit_1.0.0_amd64.deb',
        size: 'In development',
        available: false,
      },
    ],
  },
];

interface DownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DownloadModal({ isOpen, onClose }: DownloadModalProps) {
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);

  useEffect(() => {
    setDetected(detectUserOS());
  }, []);

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

  const isWinUser = detected?.family === 'win' || !detected?.family;

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

          <div className="primary-detected-download">
            <button
              className="primary-download-btn"
              onClick={() => handleDownload('Conduit.exe')}
              title="Download Conduit.exe for Windows"
            >
              <span className="download-btn-icon">
                <Ic.download size={20} />
              </span>
              <div className="download-btn-content">
                <span className="download-main-text">
                  {isWinUser ? 'Download for Windows (x64)' : 'Download Windows App (x64)'}
                </span>
                <span className="download-sub-text">
                  {isWinUser
                    ? 'v1.0.0 · Standalone Executable (.exe) · 234 MB · Free & Open Source'
                    : 'macOS & Linux in development · Conduit.exe (234 MB)'}
                </span>
              </div>
            </button>
          </div>
        </div>

        <div className="download-matrix-grid">
          {DOWNLOAD_OPTIONS.map((opt) => (
            <div
              key={opt.platform}
              className={`download-platform-card ${opt.status === 'active' ? 'platform-active' : 'platform-pending'}`}
            >
              <div className="platform-card-header">
                <span className="platform-icon">{opt.icon({ size: 20 })}</span>
                <h3 className="platform-name">{opt.osName}</h3>
                <span className={`platform-status-badge ${opt.status}`}>{opt.badge}</span>
              </div>
              <div className="platform-formats-list">
                {opt.formats.map((fmt) => (
                  <div
                    key={fmt.file}
                    className={`download-format-row ${fmt.available ? 'available' : 'unavailable'}`}
                  >
                    <div className="format-info">
                      <span className="format-label">{fmt.label}</span>
                      <span className="format-size">{fmt.size}</span>
                    </div>
                    {fmt.available ? (
                      <button
                        className="format-download-btn active"
                        onClick={() => handleDownload(fmt.file)}
                        title={`Download ${fmt.file}`}
                      >
                        {fmt.btnLabel || 'Download'}
                      </button>
                    ) : (
                      <span className="format-coming-soon-tag">Coming Soon</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="download-footer-note">
          <span>SHA-256 verified · Packaged with Electron &amp; Node-PTY · Open Source · MIT License</span>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
