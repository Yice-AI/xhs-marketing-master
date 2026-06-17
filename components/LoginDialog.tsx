import React, { useEffect, useState } from 'react';

import { BrowserTab } from '../shared/extension-contract';
import { useExtension } from '../src/hooks/useExtension';
import { detectXhsLogin, ensureXhsCreatorTab } from '../lib/xhsSession';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess?: () => void;
  autoOpenLoginPage?: boolean;
}

type LoginStatus = 'idle' | 'checking' | 'not_installed' | 'opening' | 'success' | 'failed';

const LoginDialog: React.FC<LoginDialogProps> = ({ isOpen, onClose, onLoginSuccess, autoOpenLoginPage = false }) => {
  const { extension, tab } = useExtension();
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [message, setMessage] = useState('');
  const [loginTab, setLoginTab] = useState<BrowserTab>();
  const [autoOpened, setAutoOpened] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    void checkLoginStatus();
  }, [isOpen, extension, tab]);

  useEffect(() => {
    if (!isOpen) {
      setAutoOpened(false);
      return;
    }
    if (!autoOpenLoginPage || autoOpened || status !== 'idle') return;
    setAutoOpened(true);
    void handleOpenLoginPage();
  }, [autoOpenLoginPage, autoOpened, isOpen, status]);

  useEffect(() => {
    if (!isOpen) return;
    if (status !== 'idle' && status !== 'opening') return;
    const timer = window.setInterval(() => {
      void checkLoginStatus();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isOpen, status, extension, tab, loginTab]);

  const checkLoginStatus = async () => {
    if (!extension) {
      setStatus('not_installed');
      setMessage('未检测到浏览器插件。请先安装当前主仓插件 `crx-xhs-marketing-extension-0.1.0.zip`（对象名 `xhs-marketing-extension`）。');
      return;
    }

    if (!tab) {
      setStatus('failed');
      setMessage('尚未获取到当前工作台标签页，请稍后再试。');
      return;
    }

    try {
      setStatus('checking');
      const creatorTab = await ensureXhsCreatorTab(extension, tab, loginTab, false);
      setLoginTab(creatorTab);

      if (!creatorTab?.id) {
        throw new Error('无法打开小红书创作者中心页面');
      }

      const loginStatus = await detectXhsLogin(extension, creatorTab.id);
      if (loginStatus.loggedIn) {
        setStatus('success');
        setMessage('已检测到浏览器中的小红书登录状态。');
        window.setTimeout(() => {
          onLoginSuccess?.();
          onClose();
        }, 1200);
        return;
      }

      setStatus('idle');
      setMessage(loginStatus.message);
    } catch (error) {
      console.error('检查登录状态失败:', error);
      setStatus('failed');
      setMessage(`无法检测登录状态，请确认插件正常工作后重试。${error instanceof Error && error.message ? ` (${error.message})` : ''}`);
    }
  };

  const handleOpenLoginPage = async () => {
    if (!extension || !tab) {
      setStatus('not_installed');
      setMessage('请先安装浏览器插件。');
      return;
    }

    try {
      setStatus('opening');
      const creatorTab = await ensureXhsCreatorTab(extension, tab, loginTab, true);
      setLoginTab(creatorTab);
      setMessage('已打开小红书创作者中心，请在浏览器中完成登录后返回此处重新检测。');
    } catch (error) {
      console.error('打开登录页失败:', error);
      setStatus('failed');
      setMessage('无法打开创作者中心页面，请检查插件权限或重试。');
    }
  };

  if (!isOpen) return null;

  return (
    <div style={styles.overlay}>
      <div style={styles.dialog}>
        <div style={styles.header}>
          <h2 style={styles.title}>检测小红书登录状态</h2>
          <button style={styles.closeButton} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={styles.content}>
          {status === 'checking' && (
            <div style={styles.statusContainer}>
              <div style={styles.spinner}></div>
              <p>正在检查浏览器中的真实登录状态...</p>
            </div>
          )}

          {status === 'not_installed' && (
            <div style={styles.statusContainer}>
              <p style={styles.message}>{message}</p>
              <div style={styles.infoBox}>
                <p><strong>正式插件:</strong> <code>crx-xhs-marketing-extension-0.1.0.zip</code></p>
                <p><strong>页面对象:</strong> <code>xhs-marketing-extension</code></p>
                <p><strong>说明:</strong> 请安装当前主仓已验证可用的插件包，并在浏览器中重新加载后再检测。</p>
              </div>
            </div>
          )}

          {(status === 'idle' || status === 'opening') && (
            <div style={styles.statusContainer}>
              <p style={styles.message}>{message}</p>
              <button style={styles.loginButton} onClick={handleOpenLoginPage}>
                打开小红书登录页
              </button>
              <button style={styles.retryButton} onClick={() => void checkLoginStatus()}>
                重新检测
              </button>
            </div>
          )}

          {status === 'success' && (
            <div style={styles.statusContainer}>
              <div style={styles.successIcon}>✓</div>
              <p style={styles.successMessage}>{message}</p>
            </div>
          )}

          {status === 'failed' && (
            <div style={styles.statusContainer}>
              <div style={styles.errorIcon}>✕</div>
              <p style={styles.errorMessage}>{message}</p>
              <button style={styles.retryButton} onClick={() => void checkLoginStatus()}>
                重试
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  dialog: {
    backgroundColor: 'white',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '520px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px',
    borderBottom: '1px solid #eee',
  },
  title: {
    margin: 0,
    fontSize: '20px',
    fontWeight: 600,
  },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '24px',
    cursor: 'pointer',
    color: '#999',
    padding: '0',
    width: '30px',
    height: '30px',
  },
  content: {
    padding: '30px',
    minHeight: '220px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusContainer: {
    textAlign: 'center',
    width: '100%',
  },
  message: {
    color: '#666',
    marginBottom: '20px',
    lineHeight: 1.6,
  },
  loginButton: {
    backgroundColor: '#ff2442',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    padding: '12px 32px',
    fontSize: '16px',
    fontWeight: 600,
    cursor: 'pointer',
    display: 'block',
    margin: '0 auto',
  },
  retryButton: {
    backgroundColor: '#f5f5f5',
    color: '#666',
    border: '1px solid #ddd',
    borderRadius: '8px',
    padding: '10px 24px',
    fontSize: '14px',
    cursor: 'pointer',
    display: 'block',
    margin: '12px auto 0',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '4px solid #f3f3f3',
    borderTop: '4px solid #ff2442',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
    margin: '0 auto 20px',
  },
  successIcon: {
    width: '60px',
    height: '60px',
    borderRadius: '50%',
    backgroundColor: '#10b981',
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '32px',
    margin: '0 auto 20px',
  },
  errorIcon: {
    width: '60px',
    height: '60px',
    borderRadius: '50%',
    backgroundColor: '#ef4444',
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '32px',
    margin: '0 auto 20px',
  },
  successMessage: {
    color: '#10b981',
    fontSize: '18px',
    fontWeight: 600,
  },
  errorMessage: {
    color: '#ef4444',
    fontSize: '16px',
    marginBottom: '20px',
  },
  infoBox: {
    backgroundColor: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    padding: '16px',
    textAlign: 'left',
    fontSize: '14px',
    color: '#475569',
    lineHeight: 1.7,
  },
};

export default LoginDialog;
