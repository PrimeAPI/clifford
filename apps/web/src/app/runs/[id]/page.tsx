'use client';

import { useState, useEffect } from 'react';
import { use } from 'react';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  inputText: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface RunStep {
  id: string;
  runId: string;
  seq: number;
  type: string;
  toolName?: string;
  argsJson?: Record<string, unknown>;
  resultJson?: Record<string, unknown>;
  status: string;
  createdAt: string;
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRun = async () => {
      try {
        const res = await fetch(`${API_URL}/api/runs/${id}`);
        const data = await res.json();
        setRun(data.run);
        setSteps(data.steps);
      } catch (err) {
        console.error('Failed to fetch run:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchRun();

    const interval = setInterval(fetchRun, 2000);
    return () => clearInterval(interval);
  }, [id]);

  if (loading) {
    return <div style={{ padding: '20px' }}>Loading...</div>;
  }

  if (!run) {
    return <div style={{ padding: '20px' }}>Run not found</div>;
  }

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <Link href="/" style={{ color: 'blue', textDecoration: 'underline' }}>
        ← Back to Home
      </Link>

      <h1>Run: {run.id}</h1>

      <div style={{ marginBottom: '20px', padding: '15px', background: '#f0f0f0' }}>
        <p>
          <strong>Status:</strong> {run.status}
        </p>
        <p>
          <strong>Input:</strong> {run.inputText}
        </p>
        <p>
          <strong>Agent ID:</strong> {run.agentId}
        </p>
        <p>
          <strong>Created:</strong> {new Date(run.createdAt).toLocaleString()}
        </p>
      </div>

      <h2>Steps ({steps.length})</h2>

      {steps.length === 0 && <p>No steps yet...</p>}

      {steps.map((step) => (
        <div
          key={step.id}
          style={{
            marginBottom: '15px',
            padding: '15px',
            border: '1px solid #ccc',
            borderRadius: '4px',
          }}
        >
          <p>
            <strong>
              #{step.seq} - {step.type}
            </strong>{' '}
            ({step.status})
          </p>
          {step.toolName && (
            <p>
              <strong>Tool:</strong> {step.toolName}
            </p>
          )}
          {step.argsJson && (
            <details>
              <summary>Arguments</summary>
              <pre style={{ background: '#f9f9f9', padding: '10px', overflow: 'auto' }}>
                {JSON.stringify(step.argsJson, null, 2)}
              </pre>
            </details>
          )}
          {step.resultJson && (
            <details open>
              <summary>Result</summary>
              <pre style={{ background: '#f9f9f9', padding: '10px', overflow: 'auto' }}>
                {JSON.stringify(step.resultJson, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
