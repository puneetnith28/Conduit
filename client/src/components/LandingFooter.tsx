import Ic from './Icons';

interface LandingFooterProps {
  onOpenConsole: () => void;
  onOpenDownload: () => void;
}

export default function LandingFooter({ onOpenConsole, onOpenDownload }: LandingFooterProps) {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="landing-footer">
      <div className="landing-footer-inner">
        <div className="landing-footer-brand">
          <div
            className="landing-footer-logo"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            role="button"
            tabIndex={0}
            title="Back to top"
          >
            <span className="footer-logo-icon">
              <Ic.logo size={14} />
            </span>
            <span className="footer-brand-title">CONDUIT</span>
          </div>
          <span className="landing-footer-copy">
            &copy; {currentYear} Conduit &middot; Open source under MIT License
          </span>
        </div>

        <nav className="landing-footer-links" aria-label="Footer Navigation">
          <button type="button" className="footer-link-btn" onClick={onOpenDownload}>
            Download
          </button>
          <button type="button" className="footer-link-btn" onClick={onOpenConsole}>
            Console
          </button>
          <a
            href="https://github.com/devprashant19/Conduit"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link"
          >
            GitHub
          </a>
          <a
            href="https://github.com/devprashant19/Conduit#architecture"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link"
          >
            Docs
          </a>
        </nav>
      </div>
    </footer>
  );
}
