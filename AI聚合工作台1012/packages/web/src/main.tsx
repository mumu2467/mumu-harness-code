import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { useStore } from './store/useStore';

// 先把本地持久化的会话灌进去，再首帧渲染，避免"先空后闪"
useStore.getState().hydrate();

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

createRoot(container).render(
  // StrictMode 会在开发模式重复执行 effect（WS 会连两次并立即断开一次），
  // 客户端本身按"每次 effect 各自持有连接"实现，因此是安全的。
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
