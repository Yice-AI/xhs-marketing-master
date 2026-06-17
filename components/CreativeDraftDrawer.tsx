import React, { useEffect, useState } from 'react';
import { CreativeDraftDetail, CreativeDraftSummary } from '../types';
import apiClient, { normalizeAppErrorMessage } from '../services/apiClient';

interface CreativeDraftDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (draft: CreativeDraftDetail) => Promise<void> | void;
}

const statusLabelMap: Record<string, string> = {
  latest_auto: '自动保存',
  manual_saved: '手动保存',
  archived: '已归档',
};

const CreativeDraftDrawer: React.FC<CreativeDraftDrawerProps> = ({ isOpen, onClose, onImport }) => {
  const [drafts, setDrafts] = useState<CreativeDraftSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const [brokenCoverIds, setBrokenCoverIds] = useState<string[]>([]);

  const loadDrafts = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await apiClient.getCreativeDrafts();
      if (!response.success) {
        throw new Error('草稿箱加载失败');
      }
      setBrokenCoverIds([]);
      setDrafts(response.data || []);
    } catch (err) {
      setError(normalizeAppErrorMessage(err, '草稿箱加载失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void loadDrafts();
  }, [isOpen]);

  const handleImport = async (draftId: string) => {
    try {
      setBusyDraftId(draftId);
      const response = await apiClient.getCreativeDraftDetail(draftId);
      if (!response.success) {
        throw new Error('草稿详情加载失败');
      }
      await onImport(response.data);
      onClose();
    } catch (err) {
      setError(normalizeAppErrorMessage(err, '导入草稿失败，请稍后重试'));
    } finally {
      setBusyDraftId(null);
    }
  };

  const handlePromote = async (draft: CreativeDraftSummary) => {
    const title = window.prompt('请输入草稿标题', draft.title || '未命名草稿');
    if (!title) return;
    try {
      setBusyDraftId(draft.draft_id);
      await apiClient.updateCreativeDraft(draft.draft_id, {
        title,
        status: 'manual_saved',
      });
      await loadDrafts();
    } catch (err) {
      setError(normalizeAppErrorMessage(err, '另存为手动草稿失败'));
    } finally {
      setBusyDraftId(null);
    }
  };

  const handleRename = async (draft: CreativeDraftSummary) => {
    const title = window.prompt('修改草稿标题', draft.title || '未命名草稿');
    if (!title) return;
    try {
      setBusyDraftId(draft.draft_id);
      await apiClient.updateCreativeDraft(draft.draft_id, { title });
      await loadDrafts();
    } catch (err) {
      setError(normalizeAppErrorMessage(err, '重命名草稿失败'));
    } finally {
      setBusyDraftId(null);
    }
  };

  const handleDelete = async (draft: CreativeDraftSummary) => {
    if (!window.confirm(`确认删除草稿《${draft.title}》吗？`)) return;
    try {
      setBusyDraftId(draft.draft_id);
      await apiClient.deleteCreativeDraft(draft.draft_id);
      await loadDrafts();
    } catch (err) {
      setError(normalizeAppErrorMessage(err, '删除草稿失败'));
    } finally {
      setBusyDraftId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose}>
      <div
        className="absolute right-0 top-0 h-full w-full max-w-[420px] overflow-y-auto border-l border-white/10 bg-[#121214] p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold text-white">创作草稿箱</h3>
            <p className="mt-1 text-sm text-slate-400">支持自动保存最新进度，也支持手动保存多个版本。</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300"
          >
            关闭
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {error && (
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}
          {loading && <div className="text-sm text-slate-400">正在加载草稿箱...</div>}
          {!loading && drafts.length === 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-5 text-sm text-slate-400">
              还没有云端草稿，开始创作后系统会自动保存最新进度。
            </div>
          )}
          {drafts.map((draft) => (
            <div key={draft.draft_id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white line-clamp-1">{draft.title}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
                      {statusLabelMap[draft.status] || draft.status}
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
                      {draft.preview_payload?.content_mode_label || '创作草稿'}
                    </span>
                  </div>
                </div>
                <div className="text-[11px] text-slate-500">
                  {draft.updated_at ? new Date(draft.updated_at).toLocaleString() : '--'}
                </div>
              </div>
              {draft.preview_payload?.cover_image_url && !brokenCoverIds.includes(draft.draft_id) ? (
                <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-black/20">
                  <img
                    src={draft.preview_payload.cover_image_url}
                    alt={draft.title}
                    className="h-28 w-full object-cover"
                    onError={() => setBrokenCoverIds((prev) => (prev.includes(draft.draft_id) ? prev : [...prev, draft.draft_id]))}
                  />
                </div>
              ) : null}
              <div className="mt-3 text-sm text-slate-300 line-clamp-2">
                {draft.preview_payload?.body_preview || '暂无正文摘要'}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => void handleImport(draft.draft_id)}
                  disabled={busyDraftId === draft.draft_id}
                  className="rounded-xl bg-white px-3 py-2 text-sm font-medium text-slate-900"
                >
                  导入继续编辑
                </button>
                {draft.status === 'latest_auto' && (
                  <button
                    onClick={() => void handlePromote(draft)}
                    disabled={busyDraftId === draft.draft_id}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200"
                  >
                    另存为手动草稿
                  </button>
                )}
                <button
                  onClick={() => void handleRename(draft)}
                  disabled={busyDraftId === draft.draft_id}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200"
                >
                  重命名
                </button>
                <button
                  onClick={() => void handleDelete(draft)}
                  disabled={busyDraftId === draft.draft_id}
                  className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CreativeDraftDrawer;
