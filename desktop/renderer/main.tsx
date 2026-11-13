import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('应用缺少挂载节点。');
createRoot(root).render(<App />);
