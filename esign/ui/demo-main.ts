import './esign-theme.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DemoPage} from './DemoPage.ts';
createRoot(document.getElementById('root')!).render(React.createElement(DemoPage));
