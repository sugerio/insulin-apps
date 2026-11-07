import React from 'react';
import {createRoot} from 'react-dom/client';
import {HostPage} from './HostPage.ts';
createRoot(document.getElementById('root')!).render(React.createElement(HostPage));
