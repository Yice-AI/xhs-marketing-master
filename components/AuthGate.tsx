import React, { useEffect, useState } from 'react';

import { useAuth } from '../contexts/AuthContext';
import { normalizeAppErrorMessage } from '../services/apiClient';
import { ExtensionReleaseManifest } from '../types';

const emptyForm = { username: '', password: '', email: '' };

const AuthGate: React.FC = () => {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [release, setRelease] = useState<ExtensionReleaseManifest | null>(null);
  const downloadUrl = release?.downloadUrl || '/downloads/crx-xhs-marketing-extension-0.1.0.zip';
  const publishedLabel = release?.publishedAt
    ? new Date(release.publishedAt).toLocaleString('zh-CN', { hour12: false })
    : '待发布';

  const handleDownload = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    let latestDownloadUrl = downloadUrl;
    try {
      const response = await fetch(`/api/release-manifest?t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (response.ok) {
        const data = await response.json() as ExtensionReleaseManifest;
        if (data?.downloadUrl) {
          setRelease(data);
          latestDownloadUrl = data.downloadUrl;
        }
      }
    } catch {}

    const fileName = latestDownloadUrl.split('/').pop() || 'extension.zip';
    const anchor = document.createElement('a');
    anchor.href = latestDownloadUrl;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [downloadUrl]);

  useEffect(() => {
    fetch(`/api/release-manifest?t=${Date.now()}`, {
      cache: 'no-store',
    })
      .then((response) => response.json())
      .then((data) => setRelease(data))
      .catch(() => undefined);
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      if (mode === 'login') {
        await login({ username: form.username, password: form.password });
      } else {
        await register({ username: form.username, password: form.password, email: form.email || undefined });
      }
    } catch (error) {
      setError(normalizeAppErrorMessage(error, '认证失败，请稍后重试', {
        timeoutMessage: '登录服务响应超时，请确认主仓后端已启动后重试。',
        networkErrorMessage: '无法连接主仓后端，请确认 http://localhost:8000 已启动。',
      }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-xhs-surface text-slate-100 flex items-center justify-center px-6 py-12">
      <div className="grid w-full max-w-6xl gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[32px] border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur">
          <p className="text-xs uppercase tracking-[0.28em] text-rose-300">Cloud Ready</p>
          <h1 className="mt-4 text-4xl font-bold text-white">登录后进入小红书营销工作台</h1>
          <p className="mt-4 max-w-2xl text-slate-300">
            云端只负责 AI、历史记录、素材和任务管理。采集与发布仍由你本地浏览器插件完成，所以首次进入前建议先下载安装最新插件。
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <div className="rounded-3xl bg-black/20 p-5">
              <p className="text-xs text-slate-400">当前发布版本</p>
              <p className="mt-2 text-2xl font-semibold text-white">{release?.latestVersion || '待发布'}</p>
              <p className="mt-3 text-sm text-slate-300">{release?.notes || '部署脚本会在发布时覆盖为真实插件版本。'}</p>
              <div className="mt-4 space-y-1 text-xs text-slate-400">
                <p>发布时间：{publishedLabel}</p>
                <p>releaseId：{release?.releaseId || '待发布'}</p>
                <p>buildMarker：{release?.buildMarker || '待发布'}</p>
              </div>
            </div>
            <div className="rounded-3xl bg-black/20 p-5">
              <p className="text-xs text-slate-400">最低兼容插件版本</p>
              <p className="mt-2 text-2xl font-semibold text-white">{release?.minSupportedVersion || '0.1.0'}</p>
              <p className="mt-3 text-xs text-slate-400 break-all">{downloadUrl}</p>
              <button
                type="button"
                onClick={handleDownload}
                className="mt-4 inline-flex items-center rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-black"
              >
                下载浏览器插件
              </button>
            </div>
          </div>

          <div className="mt-8 rounded-3xl border border-white/10 bg-black/20 p-5 text-sm text-slate-300">
            <p>1. 下载并安装插件 ZIP。</p>
            <p>2. 登录工作台账号。</p>
            <p>3. 打开小红书创作者页面，保持插件在线。</p>
          </div>
        </section>

        <section className="rounded-[32px] border border-white/10 bg-slate-950/70 p-8 shadow-2xl">
          <div className="mb-6 flex rounded-2xl bg-white/5 p-1">
            {(['login', 'register'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`flex-1 rounded-2xl px-4 py-3 text-sm font-semibold transition ${mode === item ? 'bg-white text-black' : 'text-slate-300'}`}
              >
                {item === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>

          <form className="space-y-4" onSubmit={submit}>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">用户名</span>
              <input
                value={form.username}
                onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none"
                placeholder="输入用户名"
                required
              />
            </label>
            {mode === 'register' && (
              <label className="block">
                <span className="mb-2 block text-sm text-slate-300">邮箱</span>
                <input
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none"
                  placeholder="可选，用于找回和运营通知"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">密码</span>
              <input
                type="password"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none"
                placeholder="至少 8 位"
                required
              />
            </label>
            {error ? <div className="rounded-2xl bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-2xl bg-white px-4 py-3 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? '处理中...' : mode === 'login' ? '登录工作台' : '注册并进入'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

export default AuthGate;
