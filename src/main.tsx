import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import '@xyflow/react/dist/style.css';
import './style.css';
// Added after startup so a slow font CDN can never hold back the first paint; the system stack shows until it arrives.
const fonts=document.createElement('link');fonts.rel='stylesheet';fonts.href='https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+KR:wght@400;500;600;700&display=swap';document.head.append(fonts);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
