'use client';

import { useState } from 'react';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const TENANT_ID = '00000000-0000-0000-0000-000000000000';
const AGENT_ID = '00000000-0000-0000-0000-000000000001';

export default function Home() {
  const [inputText, setInputText] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const createRun = async () => {
    if (!inputText.trim()) return;

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': TENANT_ID,
        },
        body: JSON.stringify({
          agentId: AGENT_ID,
          inputText,
        }),
      });

      const data = await res.json();
      setRunId(data.runId);
    } catch (err) {
      console.error('Failed to create run:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto' }}>
      <h1>Clifford</h1>
      <p>Create a new run</p>

      <div style={{ marginBottom: '20px' }}>
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Enter input text (e.g., 'ping' or 'hello world')"
          style={{
            width: '100%',
            minHeight: '100px',
            padding: '10px',
            fontSize: '14px',
            fontFamily: 'monospace',
          }}
        />
      </div>

      <button
        onClick={createRun}
        disabled={loading || !inputText.trim()}
        style={{
          padding: '10px 20px',
          fontSize: '16px',
          cursor: loading ? 'not-allowed' : 'pointer',
        }}
      >
        {loading ? 'Creating...' : 'Create Run'}
      </button>

      {runId && (
        <div style={{ marginTop: '20px', padding: '15px', background: '#f0f0f0' }}>
          <p>
            <strong>Run created:</strong> {runId}
          </p>
          <Link href={`/runs/${runId}`} style={{ color: 'blue', textDecoration: 'underline' }}>
            View Run Details
          </Link>
        </div>
      )}

      <div style={{ marginTop: '40px' }}>
        <h2>Example inputs:</h2>
        <ul>
          <li>
            <code>ping</code> - triggers system.ping tool
          </li>
          <li>
            <code>hello Alice</code> - triggers example.hello tool
          </li>
          <li>
            <code>anything else</code> - returns a message
          </li>
        </ul>
      </div>
    </div>
  );
}
