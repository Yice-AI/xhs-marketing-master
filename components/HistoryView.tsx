import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { apiClient } from '../services/apiClient';

interface ScrapeHistory {
  id: number;
  user_id: string;
  task_id: string;
  keyword: string;
  notes_count: number;
  created_at: string;
  notes_data?: any[];
  analysis_result?: any;
}

export default function HistoryView() {
  const [histories, setHistories] = useState<ScrapeHistory[]>([]);
  const [selectedTask, setSelectedTask] = useState<ScrapeHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  useEffect(() => {
    fetchHistories();
  }, []);

  const fetchHistories = async () => {
    try {
      setLoading(true);
      const res = await apiClient.getScrapeHistories();
      if (res.success) {
        setHistories(res.data);
        if (res.data.length > 0) {
          fetchTaskDetail(res.data[0].task_id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch histories:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTaskDetail = async (taskId: string) => {
    try {
      setLoading(true);
      const res = await apiClient.getScrapeHistoryDetail(taskId);
      if (res.success) {
        setSelectedTask(res.data);
      }
    } catch (err) {
      console.error('Failed to fetch task detail:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExportCSV = useCallback(() => {
    if (!selectedTask || !selectedTask.notes_data) return;
    
    const notes = selectedTask.notes_data;
    if (notes.length === 0) return;
    
    // Generate CSV
    const headers = ['标题', '作者', '点赞', '收藏', '评论', '链接'];
    const rows = notes.map(note => {
      const title = note.note_card?.display_title || note.detail?.title || '';
      const author = note.note_card?.user?.nickname || note.note_card?.user?.nick_name || note.detail?.user?.nickname || '';
      const likes = note.note_card?.interact_info?.liked_count || note.detail?.interactInfo?.likedCount || '0';
      const stars = note.note_card?.interact_info?.collected_count || note.detail?.interactInfo?.collectedCount || '0';
      const comments = note.note_card?.interact_info?.comment_count || note.detail?.interactInfo?.commentCount || '0';
      const url = `https://www.xiaohongshu.com/explore/${note.id}`;
      
      const row = [title, author, likes, stars, comments, url].map(val => `"${String(val).replace(/"/g, '""')}"`);
      return row.join(',');
    });
    
    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scrape_${selectedTask.keyword}_${new Date(selectedTask.created_at).getTime()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [selectedTask]);

  const handleReAnalyze = async () => {
    if (!selectedTask || !selectedTask.notes_data) return;
    if (!confirm('确定要重新对这份历史数据进行 AI 深度分析吗？')) return;
    
    try {
      setAnalyzing(true);
      const res = await apiClient.analyzeLocalNotes(selectedTask.notes_data);
      if (res.success) {
        await apiClient.updateScrapeHistoryAnalysis(selectedTask.task_id, { analysis_result: res.data });
        setSelectedTask({ ...selectedTask, analysis_result: res.data });
        alert('重新分析完成并已保存！');
      } else {
        alert(`分析失败: ${res.message}`);
      }
    } catch (err: any) {
      console.error('Re-analyze failed:', err);
      alert(`分析请求失败: ${err.message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const filteredHistories = useMemo(() => {
    return histories.filter(h => h.keyword.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [histories, searchQuery]);

  const Row = ({ index, style }: RowComponentProps<object>) => {
    const note = selectedTask?.notes_data?.[index];
    if (!note) return null;
    
    const title = note.note_card?.display_title || note.detail?.title || '无标题';
    const author = note.note_card?.user?.nickname || note.note_card?.user?.nick_name || note.detail?.user?.nickname || '未知作者';
    const likes = note.note_card?.interact_info?.liked_count || note.detail?.interactInfo?.likedCount || '0';
    const imgList = note.detail?.imageList ? note.detail.imageList.map((img: any) => img.urlDefault || img.url) : [note.note_card?.cover?.url_default || note.note_card?.cover?.url_pre];
    const imageUrl = imgList[0] || `https://picsum.photos/100/100?random=${index}`;

    return (
      <div style={style} className="p-2 border-b border-white/10 flex items-center gap-4 hover:bg-white/5">
        <img src={imageUrl} alt="cover" className="w-16 h-16 object-cover rounded-lg" />
        <div className="flex-1 overflow-hidden">
          <h4 className="text-white text-sm font-medium truncate">{title}</h4>
          <p className="text-white/60 text-xs mt-1">{author}</p>
        </div>
        <div className="text-white/80 text-xs whitespace-nowrap">
          <span className="material-symbols-outlined text-[14px] align-middle mr-1 text-red-400">favorite</span>
          {likes}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 bg-[#111111] border-r border-white/10 flex flex-col">
        <div className="p-4 border-b border-white/10">
          <h2 className="text-white font-medium mb-3">历史采集记录</h2>
          <input 
            type="text" 
            placeholder="搜索关键词..." 
            className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
          {filteredHistories.map(h => (
            <div 
              key={h.id} 
              onClick={() => fetchTaskDetail(h.task_id)}
              className={`p-3 rounded-lg mb-2 cursor-pointer transition-colors ${selectedTask?.task_id === h.task_id ? 'bg-red-500/20 border border-red-500/50' : 'bg-[#1A1A1A] hover:bg-[#222222] border border-transparent'}`}
            >
              <div className="text-white text-sm font-medium truncate">{h.keyword}</div>
              <div className="text-white/50 text-xs mt-1 flex justify-between">
                <span>{new Date(h.created_at).toLocaleDateString()}</span>
                <span>{h.notes_count} 条</span>
              </div>
            </div>
          ))}
          {filteredHistories.length === 0 && !loading && (
            <div className="text-center text-white/40 text-sm mt-10">暂无历史记录</div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col bg-[#0A0A0A] overflow-hidden">
        {selectedTask ? (
          <>
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex justify-between items-center bg-[#111111]">
              <div>
                <h1 className="text-xl text-white font-bold">{selectedTask.keyword}</h1>
                <p className="text-white/50 text-sm mt-1">采集时间：{new Date(selectedTask.created_at).toLocaleString()} · 共 {selectedTask.notes_count} 条数据</p>
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={handleExportCSV}
                  className="px-4 py-2 bg-[#2A2A2A] hover:bg-[#333333] text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-[18px]">download</span>
                  导出 CSV
                </button>
                <button 
                  onClick={handleReAnalyze}
                  disabled={analyzing}
                  className={`px-4 py-2 ${analyzing ? 'bg-red-500/50 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600'} text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2`}
                >
                  <span className="material-symbols-outlined text-[18px]">{analyzing ? 'hourglass_empty' : 'psychology'}</span>
                  {analyzing ? '分析中...' : '重新分析'}
                </button>
              </div>
            </div>

            {/* Content Split */}
            <div className="flex-1 flex overflow-hidden">
              {/* Left: Notes List */}
              <div className="flex-1 border-r border-white/10 flex flex-col">
                <div className="p-3 bg-[#111111] border-b border-white/10 text-white/60 text-sm font-medium">
                  数据列表 (虚拟滚动渲染)
                </div>
                <div className="flex-1 relative">
                  {selectedTask.notes_data && (
                    <List
                      defaultHeight={800}
                      rowCount={selectedTask.notes_data.length}
                      rowHeight={80}
                      rowComponent={Row}
                      rowProps={{}}
                      style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: 0 }}
                    />
                  )}
                </div>
              </div>

              {/* Right: AI Analysis Result */}
              <div className="w-[400px] bg-[#111111] flex flex-col overflow-y-auto custom-scrollbar">
                <div className="p-4 border-b border-white/10 sticky top-0 bg-[#111111]/90 backdrop-blur-sm z-10">
                  <h3 className="text-white font-medium flex items-center gap-2">
                    <span className="material-symbols-outlined text-red-400">insights</span>
                    AI 深度分析结果
                  </h3>
                </div>
                <div className="p-4">
                  {selectedTask.analysis_result ? (
                    <div className="prose prose-invert max-w-none">
                      <div className="text-white/80 text-sm whitespace-pre-wrap leading-relaxed">
                        {selectedTask.analysis_result.ai_insights || JSON.stringify(selectedTask.analysis_result, null, 2)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center text-white/40 mt-20 flex flex-col items-center gap-3">
                      <span className="material-symbols-outlined text-4xl">hourglass_empty</span>
                      <p>暂无分析结果，点击右上角重新分析</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-white/40">
            {loading ? '加载中...' : '请在左侧选择一条历史记录'}
          </div>
        )}
      </div>
    </div>
  );
}
