import './esign-theme.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RecipientPage } from './RecipientPage.ts';
createRoot(document.getElementById('root')!).render(React.createElement(RecipientPage));
