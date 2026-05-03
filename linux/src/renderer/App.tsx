import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WindowContext } from '../shared/types';
import { AgentWidget } from './AgentWidget';
import { Recorder } from './Recorder';
import './styles.css';

function App() {
  const [context, setContext] = useState<WindowContext | undefined>();

  useEffect(() => {
    void window.clicky.getWindowContext().then(setContext);
  }, []);

  if (!context) {
    return null;
  }

  if (context.type === 'recorder') {
    return <Recorder />;
  }

  if (context.type === 'agent' && context.agentId) {
    return <AgentWidget agentId={context.agentId} />;
  }

  return null;
}

createRoot(document.getElementById('root')!).render(<App />);
