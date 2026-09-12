import { useEffect, useState } from 'react';
import Ic from './Icons';

interface ModelOption { id: string; label: string }
interface VoiceOption { id: string; label: string }
interface ProviderSpec {
  id: 'browser' | 'openai' | 'gemini' | 'groq';
  label: string;
  needsKey?: 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
  sttModels?: ModelOption[];
  ttsModels?: ModelOption[];
  voices?: VoiceOption[];
}

/** Nova Sonic's own voices — see src/voice/config.ts for where this list comes from. */
const NOVA_VOICES: { id: string; label: string }[] = [
  { id: 'matthew', label: 'Matthew — male, American' },
  { id: 'tiffany', label: 'Tiffany — female, American' },
  { id: 'amy', label: 'Amy — female, British' },
];

interface VoiceConfig {
  live?: { voice: string };
  stt: {
    provider: 'browser' | 'openai' | 'gemini' | 'groq';
    model: string;
    language: string;
    saveRecordings: boolean;
  };
  tts: {
    enabled: boolean;
    provider: 'browser' | 'openai' | 'gemini' | 'groq';
    model: string;
    voice: string;
    speed: number;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onRestartTour?: () => void;
}

/**
 * BCP-47 tags, because that is what is stored and what the browser recogniser
 * needs; the cloud providers get the leading subtag. These ids must cover the
 * saved default (`en-US`) — a `<select>` whose value matches no option renders
 * the *first* option instead, so a mismatch here silently offers to switch the
 * user's speech recognition to another language the next time they press Save.
 */
const LANGS: ModelOption[] = [
  { id: '', label: 'Auto-detect language' },
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'en-IN', label: 'English (India)' },
  { id: 'es-ES', label: 'Spanish (Español)' },
  { id: 'fr-FR', label: 'French (Français)' },
  { id: 'de-DE', label: 'German (Deutsch)' },
  { id: 'hi-IN', label: 'Hindi (हिन्दी)' },
  { id: 'ja-JP', label: 'Japanese (日本語)' },
  { id: 'zh-CN', label: 'Chinese (Mainland / 简体中文)' },
  { id: 'zh-TW', label: 'Chinese (Taiwan / 繁體中文)' },
];

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`settings-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch-thumb" />
    </button>
  );
}

export default function SettingsModal({ open, onClose, onSaved, onRestartTour }: Props) {
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [providers, setProviders] = useState<ProviderSpec[]>([]);
  const [browserVoices, setBrowserVoices] = useState<{ name: string; lifelike: boolean }[]>([]);
  /** Whether Conduit answers ordinary y/n prompts itself. Harmful gates ignore it. */
  const [autoApprove, setAutoApprove] = useState(true);
  /** 'live' streams to Nova 2 Sonic; 'pipeline' is the original path. */
  const [engine, setEngine] = useState<'pipeline' | 'live'>('pipeline');

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const read = () => {
      const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
      setBrowserVoices(
        synth.getVoices()
          .filter((v) => v.lang.toLowerCase().startsWith(lang))
          .map((v) => ({
            name: v.name,
            lifelike: /natural|neural|online|premium|enhanced|wavenet|studio/i.test(v.name),
          }))
          .sort((a, b) => Number(b.lifelike) - Number(a.lifelike) || a.name.localeCompare(b.name)),
      );
    };
    read();
    synth.addEventListener?.('voiceschanged', read);
    return () => synth.removeEventListener?.('voiceschanged', read);
  }, []);

  const [keys, setKeys] = useState<{ openai: boolean; gemini: boolean }>({ openai: false, gemini: false });
  const [openaiInput, setOpenaiInput] = useState('');
  const [geminiInput, setGeminiInput] = useState('');
  const [showOpenai, setShowOpenai] = useState(false);
  const [showGemini, setShowGemini] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reloadKeys = () => {
    fetch('/api/voice/config')
      .then((r) => r.json())
      .then((d) => { if (d?.keys) setKeys(d.keys); })
      .catch(() => { /* ignore */ });
  };

  const clearKey = async (provider: 'openai' | 'gemini') => {
    setErr(null);
    try {
      const r = await fetch('/api/voice/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: { [provider]: '' } }),
      });
      if (!r.ok) throw new Error(`clear ${r.status}`);
      if (provider === 'openai') setOpenaiInput('');
      else setGeminiInput('');
      reloadKeys();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!open) return;
    setErr(null);
    fetch('/api/voice/config')
      .then((r) => r.json())
      .then((d) => {
        setCfg(d.config);
        setProviders(d.providers);
        setKeys(d.keys);
        if (d.config?.engine === 'live') setEngine('live');
      })
      .catch((e) => setErr(String(e)));
    fetch('/api/gate-settings')
      .then((r) => r.json())
      .then((d) => setAutoApprove(d.autoApproveRoutine !== false))
      .catch(() => { /* keep the default — the toggle still saves */ });
  }, [open]);

  if (!open) return null;
  if (!cfg) {
    return (
      <div className="settings-scrim" onClick={onClose}>
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <div style={{ padding: 40, color: 'var(--text-3)', textAlign: 'center' }}>
            {err || 'Loading settings…'}
          </div>
        </div>
      </div>
    );
  }

  const sttProv = providers.find((p) => p.id === cfg.stt.provider);
  const ttsProv = providers.find((p) => p.id === cfg.tts.provider);
  const keyOK = (id: 'browser' | 'openai' | 'gemini' | 'groq') =>
    id === 'browser' ? true : id === 'openai' ? keys.openai : keys.gemini;

  const sttProviders = providers.filter(
    (p) => p.id === 'browser' || (p.sttModels && p.sttModels.length > 0),
  );
  const ttsProviders = providers.filter(
    (p) => p.id === 'browser' || (p.ttsModels && p.ttsModels.length > 0),
  );

  const setSttProvider = (id: VoiceConfig['stt']['provider']) => {
    const p = providers.find((x) => x.id === id);
    setCfg({
      ...cfg,
      stt: { ...cfg.stt, provider: id, model: p?.sttModels?.[0]?.id || '' },
    });
  };

  const setTtsProvider = (id: VoiceConfig['tts']['provider']) => {
    const p = providers.find((x) => x.id === id);
    setCfg({
      ...cfg,
      tts: {
        ...cfg.tts,
        provider: id,
        model: p?.ttsModels?.[0]?.id || '',
        voice: p?.voices?.[0]?.id || '',
      },
    });
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body: {
        engine: 'pipeline' | 'live';
        stt: VoiceConfig['stt']; tts: VoiceConfig['tts'];
        live: { voice: string };
        apiKeys?: { openai?: string; gemini?: string };
      } = {
        engine, stt: cfg.stt, tts: cfg.tts,
        live: { voice: cfg.live?.voice || 'matthew' },
      };
      const apiKeys: { openai?: string; gemini?: string } = {};
      if (openaiInput.trim()) apiKeys.openai = openaiInput.trim();
      if (geminiInput.trim()) apiKeys.gemini = geminiInput.trim();
      if (Object.keys(apiKeys).length > 0) body.apiKeys = apiKeys;

      const r = await fetch('/api/voice/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `save ${r.status}`);
      }

      const g = await fetch('/api/gate-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoApproveRoutine: autoApprove }),
      });
      if (!g.ok) {
        const j = await g.json().catch(() => ({}));
        throw new Error(j.error || `approvals ${g.status}`);
      }
      setOpenaiInput('');
      setGeminiInput('');
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-h">
          <div className="settings-title-wrap">
            <div className="settings-icon-badge">
              <Ic.settings size={16} />
            </div>
            <div>
              <h3 className="settings-title">Voice & Assistant Settings</h3>
              <p className="settings-subtitle">Configure speech recognition, synthesis voices, and provider credentials</p>
            </div>
          </div>
          <button className="settings-close-btn" onClick={onClose} title="Close">
            <Ic.x size={14} />
          </button>
        </header>

        <div className="settings-body">
          {/* Speech-to-text Card */}
          <section className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-icon"><Ic.mic size={15} /></div>
              <div className="settings-card-title-wrap">
                <h4 className="settings-card-title">Speech-to-Text</h4>
                <span className="settings-card-desc">Voice input and recognition engine</span>
              </div>
            </div>
            <div className="settings-card-body">
              <div className="settings-field">
                <label className="settings-field-label">Provider</label>
                <div className="settings-field-ctrl">
                  <select
                    value={cfg.stt.provider}
                    onChange={(e) => setSttProvider(e.target.value as VoiceConfig['stt']['provider'])}
                    className="settings-select"
                  >
                    {sttProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}{p.needsKey && !keyOK(p.id) ? ' (API key missing)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {sttProv?.sttModels && sttProv.sttModels.length > 0 && (
                <div className="settings-field">
                  <label className="settings-field-label">Model</label>
                  <div className="settings-field-ctrl">
                    <select
                      value={cfg.stt.model}
                      onChange={(e) => setCfg({ ...cfg, stt: { ...cfg.stt, model: e.target.value } })}
                      className="settings-select"
                    >
                      {sttProv.sttModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div className="settings-field">
                <label className="settings-field-label">Language</label>
                <div className="settings-field-ctrl">
                  <select
                    value={cfg.stt.language}
                    onChange={(e) => setCfg({ ...cfg, stt: { ...cfg.stt, language: e.target.value } })}
                    className="settings-select"
                  >
                    {(LANGS.some((l) => l.id === cfg.stt.language)
                      ? LANGS
                      : [{ id: cfg.stt.language, label: cfg.stt.language }, ...LANGS]
                    ).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Save Audio Debug Clips</span>
                  <span className="settings-toggle-desc">Saves temporary audio captures locally for microphone diagnostics</span>
                </div>
                <ToggleSwitch
                  checked={!!cfg.stt.saveRecordings}
                  onChange={(checked) => setCfg({ ...cfg, stt: { ...cfg.stt, saveRecordings: checked } })}
                />
              </div>
            </div>
          </section>

          {/* Text-to-speech Card */}
          <section className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-icon"><Ic.volume size={15} /></div>
              <div className="settings-card-title-wrap">
                <h4 className="settings-card-title">Text-to-Speech</h4>
                <span className="settings-card-desc">Speech synthesis and Keeper voice output</span>
              </div>
            </div>
            <div className="settings-card-body">
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Spoken Assistant Replies</span>
                  <span className="settings-toggle-desc">
                    {cfg.tts.enabled
                      ? 'Active — the Keeper reads its replies aloud'
                      : 'Muted — responses are displayed as text only'}
                  </span>
                </div>
                <ToggleSwitch
                  checked={cfg.tts.enabled}
                  onChange={(checked) => setCfg({ ...cfg, tts: { ...cfg.tts, enabled: checked } })}
                />
              </div>

              {cfg.tts.enabled && (
                <div className="settings-subfields">
                  <div className="settings-field">
                    <label className="settings-field-label">Provider</label>
                    <div className="settings-field-ctrl">
                      <select
                        value={cfg.tts.provider}
                        onChange={(e) => setTtsProvider(e.target.value as VoiceConfig['tts']['provider'])}
                        className="settings-select"
                      >
                        {ttsProviders.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}{p.needsKey && !keyOK(p.id) ? ' (API key missing)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {ttsProv?.ttsModels && ttsProv.ttsModels.length > 0 && (
                    <div className="settings-field">
                      <label className="settings-field-label">Model</label>
                      <div className="settings-field-ctrl">
                        <select
                          value={cfg.tts.model}
                          onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, model: e.target.value } })}
                          className="settings-select"
                        >
                          {ttsProv.ttsModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {cfg.tts.provider === 'browser' && (
                    <div className="settings-field">
                      <label className="settings-field-label">Voice</label>
                      <div className="settings-field-ctrl">
                        <select
                          value={cfg.tts.voice}
                          onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })}
                          className="settings-select"
                        >
                          <option value="">Best available (recommended)</option>
                          {browserVoices.map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name}{v.lifelike ? ' — Natural' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {ttsProv?.voices && ttsProv.voices.length > 0 && (
                    <div className="settings-field">
                      <label className="settings-field-label">Voice</label>
                      <div className="settings-field-ctrl">
                        <select
                          value={cfg.tts.voice}
                          onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })}
                          className="settings-select"
                        >
                          {ttsProv.voices.map((v) => (
                            <option key={v.id} value={v.id}>{v.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  <div className="settings-field">
                    <label className="settings-field-label">Playback Speed</label>
                    <div className="settings-field-ctrl">
                      <select
                        value={String(cfg.tts.speed ?? 1.0)}
                        onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, speed: parseFloat(e.target.value) } })}
                        className="settings-select"
                      >
                        <option value="0.75">0.75× (Slower)</option>
                        <option value="1">1.0× (Normal)</option>
                        <option value="1.15">1.15×</option>
                        <option value="1.25">1.25×</option>
                        <option value="1.5">1.5× (Faster)</option>
                        <option value="1.75">1.75×</option>
                        <option value="2">2.0× (Fast)</option>
                      </select>
                      {cfg.tts.provider === 'gemini' && (
                        <span className="settings-inline-hint">
                          Speed adjustment is supported on OpenAI TTS.
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* API Keys Card */}
          <section className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-icon"><Ic.key size={15} /></div>
              <div className="settings-card-title-wrap">
                <h4 className="settings-card-title">API Credentials</h4>
                <span className="settings-card-desc">Bring your own keys for cloud AI speech models</span>
              </div>
            </div>
            <div className="settings-card-body">
              <div className="settings-security-banner">
                <Ic.shield size={14} />
                <span>Keys are stored locally in your environment configuration and never shared.</span>
              </div>

              <div className="settings-key-row">
                <div className="settings-key-meta">
                  <span className="settings-key-name">OpenAI</span>
                  {keys.openai ? (
                    <span className="settings-key-status ok"><Ic.check size={10} /> Saved</span>
                  ) : (
                    <span className="settings-key-status missing">Missing</span>
                  )}
                </div>
                <div className="settings-key-input-wrap">
                  <input
                    type={showOpenai ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={keys.openai ? '••••••••••••••••••••' : 'sk-proj-...'}
                    value={openaiInput}
                    onChange={(e) => setOpenaiInput(e.target.value)}
                    className="settings-input"
                  />
                  <button
                    type="button"
                    className="settings-input-icon-btn"
                    onClick={() => setShowOpenai(!showOpenai)}
                    title={showOpenai ? 'Hide key' : 'Show key'}
                  >
                    {showOpenai ? <Ic.eyeOff size={13} /> : <Ic.eye size={13} />}
                  </button>
                </div>
                {keys.openai && (
                  <button
                    type="button"
                    className="settings-key-clear-btn"
                    onClick={() => clearKey('openai')}
                    title="Remove saved key"
                  >
                    Clear
                  </button>
                )}
              </div>

              <div className="settings-key-row">
                <div className="settings-key-meta">
                  <span className="settings-key-name">Google Gemini</span>
                  {keys.gemini ? (
                    <span className="settings-key-status ok"><Ic.check size={10} /> Saved</span>
                  ) : (
                    <span className="settings-key-status missing">Missing</span>
                  )}
                </div>
                <div className="settings-key-input-wrap">
                  <input
                    type={showGemini ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={keys.gemini ? '••••••••••••••••••••' : 'AIzaSy...'}
                    value={geminiInput}
                    onChange={(e) => setGeminiInput(e.target.value)}
                    className="settings-input"
                  />
                  <button
                    type="button"
                    className="settings-input-icon-btn"
                    onClick={() => setShowGemini(!showGemini)}
                    title={showGemini ? 'Hide key' : 'Show key'}
                  >
                    {showGemini ? <Ic.eyeOff size={13} /> : <Ic.eye size={13} />}
                  </button>
                </div>
                {keys.gemini && (
                  <button
                    type="button"
                    className="settings-key-clear-btn"
                    onClick={() => clearKey('gemini')}
                    title="Remove saved key"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* How you talk to the Keeper */}
          <section className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-icon"><Ic.mic size={15} /></div>
              <div className="settings-card-title-wrap">
                <h4 className="settings-card-title">Conversation</h4>
                <span className="settings-card-desc">How talking to the Keeper works</span>
              </div>
            </div>
            <div className="settings-card-body">
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Live conversation</span>
                  <span className="settings-toggle-desc">
                    One open connection to Amazon Nova 2 Sonic. It answers in under a second,
                    hears you while it is still talking, and stops when you cut in. Needs AWS
                    credentials with <code>bedrock:InvokeModelWithBidirectionalStream</code>.
                  </span>
                </div>
                <ToggleSwitch
                  checked={engine === 'live'}
                  onChange={(on) => setEngine(on ? 'live' : 'pipeline')}
                />
              </div>
              {engine === 'live' && (
                <div className="settings-field" style={{ marginTop: 14 }}>
                  <label className="settings-field-label" htmlFor="live-voice">Voice</label>
                  <div className="settings-field-ctrl">
                    <select
                      id="live-voice"
                      className="settings-select"
                      value={cfg?.live?.voice || 'matthew'}
                      onChange={(e) => setCfg((c) => (c
                        ? { ...c, live: { voice: e.target.value } }
                        : c))}
                    >
                      {NOVA_VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                    <span className="settings-toggle-desc" style={{ display: 'block', marginTop: 6 }}>
                      Nova speaks in its own voice, so this is separate from the
                      text-to-speech voice above &mdash; that one belongs to whichever
                      provider is selected there, and Nova would not recognise it.
                    </span>
                  </div>
                </div>
              )}

              <p className="settings-toggle-desc" style={{ marginTop: 10 }}>
                Off, the Keeper uses the original path &mdash; record, transcribe, answer, speak
                &mdash; which works with any provider above and costs nothing when idle, but takes
                several seconds per exchange and cannot be interrupted. Live streams audio only
                while you are actually speaking, so an open session costs nothing in silence.
              </p>
            </div>
          </section>

          {/* Approvals — which decisions actually reach you */}
          <section className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-icon"><Ic.shield size={15} /></div>
              <div className="settings-card-title-wrap">
                <h4 className="settings-card-title">Approvals</h4>
                <span className="settings-card-desc">Which decisions reach you, and which Conduit handles</span>
              </div>
            </div>
            <div className="settings-card-body">
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Handle routine prompts for me</span>
                  <span className="settings-toggle-desc">
                    Ordinary y/n questions &mdash; &ldquo;create README.md?&rdquo; and the like &mdash;
                    are answered without interrupting you. Each one appears in the project&rsquo;s
                    group chat as one line: what was asked, and that it was allowed.
                  </span>
                </div>
                <ToggleSwitch checked={autoApprove} onChange={setAutoApprove} />
              </div>
              <p className="settings-toggle-desc" style={{ marginTop: 10 }}>
                These always come to you, whatever this is set to: <code>rm -rf</code>,{' '}
                <code>git push --force</code>, <code>git reset --hard</code>, <code>DROP TABLE</code>,{' '}
                <code>kubectl delete</code>, <code>terraform destroy</code> and the rest &mdash; plus
                anything the Supervisor flags as risky, and any prompt Conduit cannot confidently
                recognise.
              </p>
            </div>
          </section>

          {/* Onboarding Tour Card */}
          {onRestartTour && (
            <section className="settings-card">
              <div className="settings-card-header">
                <div className="settings-card-icon"><Ic.sparkles size={15} /></div>
                <div className="settings-card-title-wrap">
                  <h4 className="settings-card-title">Interactive Tour</h4>
                  <span className="settings-card-desc">Product walkthrough and onboarding experience</span>
                </div>
              </div>
              <div className="settings-card-body">
                <div className="settings-action-row">
                  <div className="settings-action-info">
                    <span className="settings-action-label">Workspace Guided Walkthrough</span>
                    <span className="settings-action-desc">Replay the interactive tour of agents, terminals, and navigation</span>
                  </div>
                  <button
                    type="button"
                    className="hbtn"
                    onClick={() => {
                      onClose();
                      onRestartTour();
                    }}
                  >
                    Restart Tour
                  </button>
                </div>
              </div>
            </section>
          )}

          {err && <div className="settings-err">{err}</div>}
        </div>

        <footer className="settings-f">
          <button className="hbtn" onClick={onClose}>Cancel</button>
          <button className="hbtn primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </footer>
      </div>
    </div>
  );
}

