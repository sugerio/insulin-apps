import React from 'react';
import {createRoot} from 'react-dom/client';
import {SyntheticHostPage} from './SyntheticHostPage.ts';
createRoot(document.getElementById('root')!).render(React.createElement(SyntheticHostPage));
