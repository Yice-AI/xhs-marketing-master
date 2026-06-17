
import React from 'react';
import { CreationMode } from '../types';

interface HomeViewProps {
  onSelectMode: (mode: CreationMode) => void;
}

const HomeView: React.FC<HomeViewProps> = ({ onSelectMode }) => {
  return (
    <div className="relative min-h-[calc(100vh-200px)] flex items-center justify-center overflow-hidden">
      <div className="fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff08_1px,transparent_1px),linear-gradient(to_bottom,#ffffff08_1px,transparent_1px)] bg-[size:4rem_4rem]"></div>

        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-purple-500/30 rounded-full blur-[120px] animate-pulse"></div>
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-red-500/30 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }}></div>

        {[...Array(20)].map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 bg-white/30 rounded-full"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animation: `float ${3 + Math.random() * 4}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 2}s`,
            }}
          />
        ))}
      </div>

      <div className="max-w-6xl w-full px-8 z-10">
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold text-white mb-4 bg-clip-text text-transparent bg-gradient-to-r from-white via-purple-200 to-white">
            选择笔记生成方式
          </h1>
          <p className="text-slate-400 text-lg">
            请选择最适合您当前营销需求的 AI 生成模式，打造高质量的红书笔记内容。
          </p>
        </div>

        <div className="relative z-20 mb-8 rounded-[2rem] border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Extension Baseline</p>
              <h2 className="mt-2 text-2xl font-bold text-white">当前工作台使用主仓浏览器插件</h2>
              <p className="mt-2 text-slate-300">
                请安装当前主仓插件 <code>crx-xhs-marketing-extension-0.1.0.zip</code>。网页侧正式识别对象为 <code>xhs-marketing-extension</code>，
                页面内下载入口已切换到当前这版可用插件包。
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-5 py-3 text-sm text-slate-200">
              安装主仓插件后，刷新页面即可连接
            </div>
          </div>
        </div>

        <div className="relative z-10 grid grid-cols-2 gap-8">
          <div
            onClick={() => onSelectMode('interview')}
            className="group relative cursor-pointer"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-white/5 to-transparent backdrop-blur-2xl rounded-[2rem] border border-white/20 transition-all duration-500 group-hover:border-purple-500/50"></div>

            <div className="absolute inset-0 bg-gradient-to-br from-purple-500/20 via-transparent to-blue-500/20 rounded-[2rem] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>

            <div className="absolute inset-[1px] bg-gradient-to-br from-white/20 via-transparent to-transparent rounded-[2rem] opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

            <div className="absolute -top-40 -right-40 w-80 h-80 bg-white/10 rounded-full blur-3xl group-hover:blur-2xl transition-all duration-700"></div>

            <div className="relative p-10 transform group-hover:scale-[1.02] transition-transform duration-500">
              <div className="relative group/icon mb-8">
                <div className="absolute inset-0 bg-gradient-to-br from-purple-600/50 to-blue-600/50 rounded-3xl blur-xl transform translate-y-2 group-hover/icon:translate-y-3 transition-transform"></div>

                <div className="relative w-24 h-24 bg-gradient-to-br from-purple-500/30 to-blue-500/30 backdrop-blur-xl rounded-3xl flex items-center justify-center border border-white/20 transform group-hover/icon:-translate-y-2 group-hover/icon:rotate-6 transition-all duration-500 shadow-2xl">
                  <span className="text-7xl filter drop-shadow-2xl">💬</span>
                </div>

                <div className="absolute inset-0 bg-gradient-to-br from-purple-400/0 via-purple-400/20 to-blue-400/0 rounded-3xl opacity-0 group-hover/icon:opacity-100 transition-opacity duration-500"></div>
              </div>

              <div className="flex items-center gap-3 mb-4">
                <div className="w-1 h-10 bg-gradient-to-b from-purple-500 via-blue-500 to-purple-500 rounded-full"></div>
                <h3 className="text-3xl font-bold text-white">AI 访谈对话生成</h3>
              </div>

              <p className="text-slate-300 mb-8 leading-relaxed">
                通过深度对话，挖掘产品亮点，量身定制品牌调性，创作100%原创内容化笔。
              </p>

              <ul className="space-y-4 mb-10">
                {['深度挖掘产品亮点', '定制化品牌调性', '100% 原创内容'].map((text, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-200 group/item">
                    <div className="relative">
                      <div className="absolute inset-0 bg-purple-500/30 rounded-full blur-md"></div>
                      <div className="relative w-7 h-7 rounded-full bg-gradient-to-br from-purple-500/30 to-blue-500/30 backdrop-blur-sm flex items-center justify-center border border-white/20 group-hover/item:scale-110 transition-transform">
                        <div className="w-2 h-2 bg-gradient-to-br from-purple-400 to-blue-400 rounded-full"></div>
                      </div>
                    </div>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>

              <button className="group/btn relative w-full overflow-hidden rounded-2xl">
                <div className="absolute inset-0 bg-gradient-to-r from-white via-white to-white"></div>

                <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 via-blue-500/20 to-pink-500/20 translate-x-[-100%] group-hover/btn:translate-x-[100%] transition-transform duration-700"></div>

                <div className="absolute inset-0 bg-gradient-to-br from-white/40 via-transparent to-transparent opacity-0 group-hover/btn:opacity-100 transition-opacity"></div>

                <span className="relative z-10 py-4 text-black font-bold flex items-center justify-center gap-2">
                  立即开始
                  <span className="transform group-hover/btn:translate-x-2 transition-transform">→</span>
                </span>
              </button>
            </div>
          </div>

          <div
            onClick={() => onSelectMode('scraper')}
            className="group relative cursor-pointer"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-white/5 to-transparent backdrop-blur-2xl rounded-[2rem] border border-white/20 transition-all duration-500 group-hover:border-red-500/50"></div>

            <div className="absolute inset-0 bg-gradient-to-br from-red-500/20 via-transparent to-orange-500/20 rounded-[2rem] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>

            <div className="absolute inset-[1px] bg-gradient-to-br from-white/20 via-transparent to-transparent rounded-[2rem] opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

            <div className="absolute -top-40 -right-40 w-80 h-80 bg-white/10 rounded-full blur-3xl group-hover:blur-2xl transition-all duration-700"></div>

            <div className="relative p-10 transform group-hover:scale-[1.02] transition-transform duration-500">
              <div className="relative group/icon mb-8">
                <div className="absolute inset-0 bg-gradient-to-br from-red-600/50 to-orange-600/50 rounded-3xl blur-xl transform translate-y-2 group-hover/icon:translate-y-3 transition-transform"></div>

                <div className="relative w-24 h-24 bg-gradient-to-br from-red-500/30 to-orange-500/30 backdrop-blur-xl rounded-3xl flex items-center justify-center border border-white/20 transform group-hover/icon:-translate-y-2 group-hover/icon:rotate-6 transition-all duration-500 shadow-2xl">
                  <span className="text-7xl filter drop-shadow-2xl">🔥</span>
                </div>

                <div className="absolute inset-0 bg-gradient-to-br from-red-400/0 via-red-400/20 to-orange-400/0 rounded-3xl opacity-0 group-hover/icon:opacity-100 transition-opacity duration-500"></div>
              </div>

              <div className="flex items-center gap-3 mb-4">
                <div className="w-1 h-10 bg-gradient-to-b from-red-500 via-orange-500 to-red-500 rounded-full"></div>
                <h3 className="text-3xl font-bold text-white">爆款克隆生成</h3>
              </div>

              <p className="text-slate-300 mb-8 leading-relaxed">
                基于已采集的爆款笔记数据，结合您的产品卖点，快速批量产出高转化率笔记。
              </p>

              <ul className="space-y-4 mb-10">
                {['复用爆款数据逻辑', '结合产品卖点重组', '快速批量产出'].map((text, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-200 group/item">
                    <div className="relative">
                      <div className="absolute inset-0 bg-red-500/30 rounded-full blur-md"></div>
                      <div className="relative w-7 h-7 rounded-full bg-gradient-to-br from-red-500/30 to-orange-500/30 backdrop-blur-sm flex items-center justify-center border border-white/20 group-hover/item:scale-110 transition-transform">
                        <div className="w-2 h-2 bg-gradient-to-br from-red-400 to-orange-400 rounded-full"></div>
                      </div>
                    </div>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>

              <button className="group/btn relative w-full overflow-hidden rounded-2xl">
                <div className="absolute inset-0 bg-gradient-to-r from-white via-white to-white"></div>

                <div className="absolute inset-0 bg-gradient-to-r from-red-500/20 via-orange-500/20 to-pink-500/20 translate-x-[-100%] group-hover/btn:translate-x-[100%] transition-transform duration-700"></div>

                <div className="absolute inset-0 bg-gradient-to-br from-white/40 via-transparent to-transparent opacity-0 group-hover/btn:opacity-100 transition-opacity"></div>

                <span className="relative z-10 py-4 text-black font-bold flex items-center justify-center gap-2">
                  立即开始
                  <span className="transform group-hover/btn:translate-x-2 transition-transform">→</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div >
  );
};

export default HomeView;
