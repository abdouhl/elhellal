import { useEffect, useRef, useState } from 'react';
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

const DEFAULT_PREFS: PushPrefs = { categories: '*', frequency: 'daily' };

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

    if (status === 'loading') return <div className="notif-card" aria-busy="true" />;

    if (status === 'ios-install') {
        return (
            <div className="notif-card">
                <p className="notif-lead">على iPhone وiPad تعمل الإشعارات بعد تثبيت الهلال على الشاشة الرئيسية:</p>
                <ol className="notif-steps">
                    <li>اضغط زر المشاركة في Safari.</li>
                    <li>اختر «إضافة إلى الشاشة الرئيسية».</li>
                    <li>افتح الهلال من الشاشة الرئيسية وارجع إلى هذه الصفحة.</li>
                </ol>
            </div>
        );
    }

    if (status === 'unsupported') {
        return (
            <div className="notif-card">
                <p className="notif-lead">متصفحك لا يدعم الإشعارات. جرّب أحدث إصدار من Chrome أو Edge أو Firefox أو Safari.</p>
            </div>
        );
    }

    return (
        <div className="notif-card">
            <div className="notif-head">
                <p className="notif-lead">
                    {status === 'on'
                        ? 'الإشعارات مفعّلة على هذا الجهاز.'
                        : 'احصل على أفضل المقالات الجديدة في المواضيع التي تهمك، دون إزعاج: إشعار واحد في اليوم أو في الأسبوع.'}
                </p>
                {status === 'on' ? (
                    <button type="button" className="notif-button notif-button--ghost" onClick={disable} disabled={busy}>
                        إيقاف الإشعارات
                    </button>
                ) : (
                    <button type="button" className="notif-button" onClick={enable} disabled={busy || status === 'denied'}>
                        تفعيل الإشعارات
                    </button>
                )}
            </div>

            {status === 'denied' && <p className="notif-message">{ERRORS.denied}</p>}
            {message && status !== 'denied' && (
                <p className="notif-message" role="status">
                    {message}
                </p>
            )}

            <fieldset className="notif-group">
                <legend>كم مرة؟</legend>
                <label className="notif-option">
                    <input
                        type="radio"
                        name="frequency"
                        checked={prefs.frequency === 'daily'}
                        onChange={() => setFrequency('daily')}
                    />
                    يومياً، مساءً
                </label>
                <label className="notif-option">
                    <input
                        type="radio"
                        name="frequency"
                        checked={prefs.frequency === 'weekly'}
                        onChange={() => setFrequency('weekly')}
                    />
                    أسبوعياً، كل جمعة
                </label>
            </fieldset>

            <fieldset className="notif-group">
                <legend>أي المواضيع؟</legend>
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
            </fieldset>

            {status === 'on' && (
                <button type="button" className="notif-link" onClick={test} disabled={busy}>
                    أرسل إشعاراً تجريبياً
                </button>
            )}
        </div>
    );
}
