/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import pg from 'pg';
import dotenv from 'dotenv';
import type { ConversationRecord, MessageRecord } from './chatRecordingService.js';

dotenv.config();

const { Pool } = pg;

export interface DatabaseConfig {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

class DatabaseService {
  private pool: pg.Pool | null = null;
  private isConnected: boolean = false;
  private static instance: DatabaseService;

  private constructor() {}

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  async initialize(config?: DatabaseConfig): Promise<void> {
    const connectionString = config?.connectionString || process.env.DATABASE_URL;

    if (!connectionString) {
      console.warn('[DatabaseService] No DATABASE_URL provided. Database will not be available.');
      return;
    }

    try {
      this.pool = new Pool({
        connectionString,
        max: config?.max || 20,
        idleTimeoutMillis: config?.idleTimeoutMillis || 30000,
        connectionTimeoutMillis: config?.connectionTimeoutMillis || 2000,
      });

      // Test the connection
      const client = await this.pool.connect();
      client.release();

      this.isConnected = true;
      console.log('[DatabaseService] Connected to PostgreSQL database');

      // Run migrations
      await this.runMigrations();
    } catch (error) {
      console.error('[DatabaseService] Failed to connect to database:', error);
      this.isConnected = false;
    }
  }

  private async runMigrations(): Promise<void> {
    if (!this.pool) return;

    const migrations = [
      // Sessions table
      `CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        project_hash VARCHAR(255) NOT NULL,
        start_time TIMESTAMP NOT NULL,
        last_updated TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,
      // Messages table
      `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) REFERENCES sessions(session_id) ON DELETE CASCADE,
        message_id VARCHAR(255) UNIQUE NOT NULL,
        message_type VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_cached INTEGER,
        tokens_thoughts INTEGER,
        tokens_tool INTEGER,
        tokens_total INTEGER,
        model VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,
      // Tool calls table
      `CREATE TABLE IF NOT EXISTS tool_calls (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(255) REFERENCES messages(message_id) ON DELETE CASCADE,
        tool_call_id VARCHAR(255) NOT NULL,
        tool_name VARCHAR(255) NOT NULL,
        tool_args JSONB,
        tool_result JSONB,
        tool_status VARCHAR(50),
        display_name VARCHAR(255),
        description TEXT,
        result_display TEXT,
        render_output_as_markdown BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,
      // Thoughts table
      `CREATE TABLE IF NOT EXISTS thoughts (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(255) REFERENCES messages(message_id) ON DELETE CASCADE,
        thought_id VARCHAR(255) NOT NULL,
        thought_type VARCHAR(50),
        content TEXT,
        timestamp TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,
      // Create indexes for better query performance
      `CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_project_hash ON sessions(project_hash);`,
      `CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);`,
      `CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id);`,
      `CREATE INDEX IF NOT EXISTS idx_thoughts_message_id ON thoughts(message_id);`,
    ];

    const client = await this.pool.connect();
    try {
      for (const migration of migrations) {
        await client.query(migration);
      }
      console.log('[DatabaseService] Migrations completed successfully');
    } catch (error) {
      console.error('[DatabaseService] Migration error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  isDatabaseAvailable(): boolean {
    return this.isConnected && this.pool !== null;
  }

  getPool(): pg.Pool | null {
    return this.pool;
  }

  // Session operations
  async createSession(session: ConversationRecord): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    const query = `
      INSERT INTO sessions (session_id, project_hash, start_time, last_updated)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (session_id) DO UPDATE SET
        project_hash = EXCLUDED.project_hash,
        last_updated = EXCLUDED.last_updated
    `;

    await this.pool.query(query, [
      session.sessionId,
      session.projectHash,
      new Date(session.startTime),
      new Date(session.lastUpdated),
    ]);
  }

  async updateSession(sessionId: string, lastUpdated: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    const query = `
      UPDATE sessions SET last_updated = $1 WHERE session_id = $2
    `;

    await this.pool.query(query, [new Date(lastUpdated), sessionId]);
  }

  async getSession(sessionId: string): Promise<ConversationRecord | null> {
    if (!this.pool) throw new Error('Database not initialized');

    // Get session
    const sessionQuery = `SELECT * FROM sessions WHERE session_id = $1`;
    const sessionResult = await this.pool.query(sessionQuery, [sessionId]);

    if (sessionResult.rows.length === 0) return null;

    const sessionRow = sessionResult.rows[0];

    // Get messages for this session
    const messagesQuery = `SELECT * FROM messages WHERE session_id = $1 ORDER BY timestamp ASC`;
    const messagesResult = await this.pool.query(messagesQuery, [sessionId]);

    const messages: MessageRecord[] = [];

    for (const msgRow of messagesResult.rows) {
      // Get tool calls for this message
      const toolCallsQuery = `SELECT * FROM tool_calls WHERE message_id = $1`;
      const toolCallsResult = await this.pool.query(toolCallsQuery, [msgRow.message_id]);

      // Get thoughts for this message
      const thoughtsQuery = `SELECT * FROM thoughts WHERE message_id = $1`;
      const thoughtsResult = await this.pool.query(thoughtsQuery, [msgRow.message_id]);

      const message: MessageRecord = {
        id: msgRow.message_id,
        timestamp: msgRow.timestamp,
        type: msgRow.message_type,
        content: msgRow.content,
      };

      if (msgRow.tokens_total !== null) {
        message.tokens = {
          input: msgRow.tokens_input || 0,
          output: msgRow.tokens_output || 0,
          cached: msgRow.tokens_cached || 0,
          thoughts: msgRow.tokens_thoughts || undefined,
          tool: msgRow.tokens_tool || undefined,
          total: msgRow.tokens_total || 0,
        };
      }

      if (msgRow.model) {
        message.model = msgRow.model;
      }

      if (toolCallsResult.rows.length > 0) {
        message.toolCalls = toolCallsResult.rows.map((tc) => ({
          id: tc.tool_call_id,
          name: tc.tool_name,
          args: tc.tool_args || {},
          result: tc.tool_result,
          status: tc.tool_status,
          timestamp: tc.timestamp,
          displayName: tc.display_name,
          description: tc.description,
          resultDisplay: tc.result_display,
          renderOutputAsMarkdown: tc.render_output_as_markdown,
        }));
      }

      if (thoughtsResult.rows.length > 0) {
        message.thoughts = thoughtsResult.rows.map((t) => ({
          thoughtId: t.thought_id,
          thoughtType: t.thought_type,
          content: t.content,
          timestamp: t.timestamp,
        }));
      }

      messages.push(message);
    }

    return {
      sessionId: sessionRow.session_id,
      projectHash: sessionRow.project_hash,
      startTime: sessionRow.start_time,
      lastUpdated: sessionRow.last_updated,
      messages,
    };
  }

  async saveMessage(sessionId: string, message: MessageRecord): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    // Insert message
    const messageQuery = `
      INSERT INTO messages (session_id, message_id, message_type, content, timestamp, 
        tokens_input, tokens_output, tokens_cached, tokens_thoughts, tokens_tool, tokens_total, model)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (message_id) DO UPDATE SET
        content = EXCLUDED.content,
        tokens_input = EXCLUDED.tokens_input,
        tokens_output = EXCLUDED.tokens_output,
        tokens_cached = EXCLUDED.tokens_cached,
        tokens_thoughts = EXCLUDED.tokens_thoughts,
        tokens_tool = EXCLUDED.t_tokens_tool,
        tokens_total = EXCLUDED.tokens_total
    `;

    await this.pool.query(messageQuery, [
      sessionId,
      message.id,
      message.type,
      message.content,
      new Date(message.timestamp),
      message.tokens?.input || null,
      message.tokens?.output || null,
      message.tokens?.cached || null,
      message.tokens?.thoughts || null,
      message.tokens?.tool || null,
      message.tokens?.total || null,
      message.model || null,
    ]);

    // Save tool calls if present
    if (message.toolCalls) {
      for (const tc of message.toolCalls) {
        const toolCallQuery = `
          INSERT INTO tool_calls (message_id, tool_call_id, tool_name, tool_args, tool_result, 
            tool_status, display_name, description, result_display, render_output_as_markdown)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (tool_call_id) DO UPDATE SET
            tool_result = EXCLUDED.tool_result,
            tool_status = EXCLUDED.tool_status
        `;

        await this.pool.query(toolCallQuery, [
          message.id,
          tc.id,
          tc.name,
          JSON.stringify(tc.args),
          tc.result ? JSON.stringify(tc.result) : null,
          tc.status,
          tc.displayName || null,
          tc.description || null,
          tc.resultDisplay || null,
          tc.renderOutputAsMarkdown || false,
        ]);
      }
    }

    // Save thoughts if present
    if (message.thoughts) {
      for (const thought of message.thoughts) {
        const thoughtQuery = `
          INSERT INTO thoughts (message_id, thought_id, thought_type, content, timestamp)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (thought_id) DO NOTHING
        `;

        await this.pool.query(thoughtQuery, [
          message.id,
          thought.thoughtId,
          thought.thoughtType || null,
          thought.content || null,
          new Date(thought.timestamp),
        ]);
      }
    }

    // Update session last_updated
    await this.updateSession(sessionId, message.timestamp);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    // Delete related records first (cascading should handle this, but being explicit)
    await this.pool.query(`DELETE FROM tool_calls WHERE message_id IN (SELECT message_id FROM messages WHERE session_id = $1)`, [sessionId]);
    await this.pool.query(`DELETE FROM thoughts WHERE message_id IN (SELECT message_id FROM messages WHERE session_id = $1)`, [sessionId]);
    await this.pool.query(`DELETE FROM messages WHERE session_id = $1`, [sessionId]);
    await this.pool.query(`DELETE FROM sessions WHERE session_id = $1`, [sessionId]);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isConnected = false;
      console.log('[DatabaseService] Database connection closed');
    }
  }
}

export const databaseService = DatabaseService.getInstance();

