import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    currentSubscription,
    fetchPrefs,
    pushSupport,
    savePrefs,
    sendTest,
    subscribe,
    unsubscribe,
    type Frequency,
    type PushPrefs,
    type PushSupport,
} from '../lib/push-client';
import './NotificationSettings.css';

interface NotificationSettingsProps {
    /** [category, title], most articles first */
    categories: Array<[string, string]>;
}

type Status = 'loading' | PushSupport | 'denied' | 'off' | 'on';

const DEFAULT_PREFS: PushPrefs = { categories: '*', frequency: 'daily', extra: false };

const ERRORS: Record<string, string> = {
    denied: 'رُفض الإذن بالإشعارات. اسمح بها لهذا الموقع من إعدادات المتصفح ثم أعد المحاولة.',
    dismissed: 'لم يُمنح الإذن بعد. اضغط «تفعيل الإشعارات» مرة أخرى واختر «السماح».',
    'try again in a minute': 'أُرسل إشعار تجريبي للتو. حاول مرة أخرى بعد دقيقة.',
};

export default function NotificationSettings({ categories }: NotificationSettingsProps) {
    const [status, setStatus] = useState<Status>('loading');
    const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PREFS);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const subRef = useRef<PushSubscription | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        const support = pushSupport();
        if (support !== 'ok') {
            setStatus(support);
            return;
        }
        if (Notification.permission === 'denied') {
            setStatus('denied');
            return;
        }
        currentSubscription()
            .then(async (sub) => {
                subRef.current = sub;
                if (!sub) return setStatus('off');
                const stored = await fetchPrefs(sub).catch(() => null);
                if (stored) setPrefs(stored);
                // Subscribed in the browser but unknown to the server (expired
                // or never saved): save it again with the defaults.
                else await savePrefs(sub, DEFAULT_PREFS).catch(() => {});
                setStatus('on');
            })
            .catch(() => setStatus('off'));
    }, []);

    const fail = (err: unknown) => {
        const key = err instanceof Error ? err.message : '';
        setMessage(ERRORS[key] || 'تعذّر الاتصال بالخادم. تحقق من اتصالك وحاول مجدداً.');
        if (key === 'denied') setStatus('denied');
    };

    const update = (next: PushPrefs) => {
        setPrefs(next);
        setMessage(null);
        const sub = subRef.current;
        if (status !== 'on' || !sub) return;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            savePrefs(sub, next).then(() => setMessage('تم حفظ تفضيلاتك.'), fail);
        }, 600);
    };

    const enable = async () => {
        setBusy(true);
        setMessage(null);
        try {
            subRef.current = await subscribe(prefs);
            setStatus('on');
            setMessage('تم تفعيل الإشعارات. ستصلك رسالة ترحيب خلال لحظات.');
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const disable = async () => {
        if (!subRef.current) return;
        setBusy(true);
        try {
            await unsubscribe(subRef.current);
            subRef.current = null;
            setStatus('off');
            setMessage('تم إيقاف الإشعارات.');
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        if (!subRef.current) return;
        setBusy(true);
        try {
            await sendTest(subRef.current);
            setMessage('أُرسل إشعار تجريبي.');
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const all = prefs.categories === '*';
    const chosen = new Set(all ? [] : prefs.categories);
    const toggleCategory = (category: string) => {
        const next = new Set(chosen);
        if (next.has(category)) next.delete(category);
        else next.add(category);
        update({ ...prefs, categories: next.size === 0 ? '*' : [...next] });
    };
    const setFrequency = (frequency: Frequency) => update({ ...prefs, frequency });

    if (status === 'loading') return <div className="notif" aria-busy="true" />;

    if (status === 'ios-install') {
        return (
            <div className="notif">
                <Hero title="ثبّت الهلال أولاً" text="على iPhone وiPad تعمل الإشعارات بعد تثبيت الهلال على الشاشة الرئيسية." />
                <ol className="notif-list notif-steps">
                    <li>اضغط زر المشاركة في Safari.</li>
                    <li>اختر «إضافة إلى الشاشة الرئيسية».</li>
                    <li>افتح الهلال من الشاشة الرئيسية وارجع إلى هذه الصفحة.</li>
                </ol>
                {/* src/scripts/pwa-install.ts shows the steps for this browser. */}
                <button type="button" className="notif-button" data-install-trigger="card">
                    اعرض خطوات التثبيت
                </button>
            </div>
        );
    }

    if (status === 'unsupported') {
        return (
            <div className="notif">
                <Hero title="الإشعارات غير مدعومة" text="متصفحك لا يدعم الإشعارات. جرّب أحدث إصدار من Chrome أو Edge أو Firefox أو Safari." />
            </div>
        );
    }

    const on = status === 'on';

    return (
        <div className="notif">
            <Hero
                on={on}
                title={on ? 'الإشعارات مفعّلة' : 'لا تفوّت الأفضل'}
                text={
                    on
                        ? 'تصلك أفضل المقالات الجديدة على هذا الجهاز.'
                        : 'أفضل المقالات الجديدة في المواضيع التي تهمك، دون إزعاج: إشعاران في اليوم، أو واحد في الأسبوع.'
                }
            >
                <Switch
                    checked={on}
                    label={on ? 'إيقاف الإشعارات' : 'تفعيل الإشعارات'}
                    disabled={busy || status === 'denied'}
                    onChange={on ? disable : enable}
                />
            </Hero>

            {status === 'denied' && <p className="notif-message is-alert">{ERRORS.denied}</p>}
            {message && status !== 'denied' && (
                <p className="notif-message" role="status">
                    {message}
                </p>
            )}

            <section className="notif-section">
                <h2>كم مرة؟</h2>
                <div className="notif-list" role="radiogroup" aria-label="كم مرة؟">
                    <label className="notif-row">
                        <span className="notif-row-text">
                            <strong>يومياً</strong>
                            <small>الجديد مساءً، وقراءة قصيرة قبل النوم</small>
                        </span>
                        <input
                            type="radio"
                            name="frequency"
                            className="notif-radio"
                            checked={prefs.frequency === 'daily'}
                            onChange={() => setFrequency('daily')}
                        />
                    </label>
                    <label className="notif-row">
                        <span className="notif-row-text">
                            <strong>أسبوعياً</strong>
                            <small>كل جمعة، أفضل ما أُضيف في الأسبوع</small>
                        </span>
                        <input
                            type="radio"
                            name="frequency"
                            className="notif-radio"
                            checked={prefs.frequency === 'weekly'}
                            onChange={() => setFrequency('weekly')}
                        />
                    </label>
                </div>
                <div className={`notif-list ${prefs.frequency !== 'daily' ? 'is-disabled' : ''}`}>
                    <label className="notif-row">
                        <span className="notif-row-text">
                            <strong>إشعارات أكثر</strong>
                            <small>حتى 5 يومياً: مقال الصباح، اقتباس الظهيرة، سؤال اليوم</small>
                        </span>
                        <Switch
                            checked={prefs.frequency === 'daily' && prefs.extra === true}
                            label="إشعارات أكثر"
                            disabled={prefs.frequency !== 'daily'}
                            onChange={() => update({ ...prefs, extra: !prefs.extra })}
                        />
                    </label>
                </div>
                <p className="notif-note">
                    وإن كانت لك سلسلة في «سؤال اليوم» (تبويب استكشف) ولم تجب بعد، نذكّرك بها مرة واحدة ليلاً.
                </p>
            </section>

            <section className="notif-section">
                <h2>أي المواضيع؟</h2>
                <div className="notif-chips">
                    <button
                        type="button"
                        className={`notif-chip ${all ? 'is-on' : ''}`}
                        aria-pressed={all}
                        onClick={() => update({ ...prefs, categories: '*' })}
                    >
                        كل المواضيع
                    </button>
                    {categories.map(([category, title]) => (
                        <button
                            key={category}
                            type="button"
                            className={`notif-chip ${chosen.has(category) ? 'is-on' : ''}`}
                            aria-pressed={chosen.has(category)}
                            onClick={() => toggleCategory(category)}
                        >
                            {title}
                        </button>
                    ))}
                </div>
            </section>

            {on && (
                <button type="button" className="notif-button notif-button--ghost" onClick={test} disabled={busy}>
                    أرسل إشعاراً تجريبياً
                </button>
            )}
        </div>
    );
}

function Hero({ on, title, text, children }: { on?: boolean; title: string; text: string; children?: ReactNode }) {
    return (
        <section className={`notif-hero ${on ? 'is-on' : ''}`}>
            <span className="notif-hero-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
            </span>
            <span className="notif-hero-text">
                <strong>{title}</strong>
                <small>{text}</small>
            </span>
            {children}
        </section>
    );
}

function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            className="notif-switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={(e) => {
                e.preventDefault();
                onChange();
            }}
        />
    );
}
