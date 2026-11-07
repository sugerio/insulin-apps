import './esign-theme.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CandidatePage} from './CandidatePage.ts';
// This build-time value is an origin, never a credential.
createRoot(document.getElementById('root')!).render(React.createElement(CandidatePage,{gateway:import.meta.env.VITE_CANDIDATE_GATEWAY_ORIGIN ?? ''}));
