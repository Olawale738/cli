# Database Integration Implementation Plan

## Information Gathered

### Project Structure
- **Project Type**: Monorepo with CLI packages (cli, core, test-utils, vscode-ide-companion)
- **Current Storage**: File-based storage using:
  - JSON files for settings (`~/.blackboxcli/settings.json`)
  - Markdown files for memory (`~/.blackboxcli/BLACKBOX.md`) 
  - JSON files for conversation history (`~/.blackboxcli/tmp/<project_hash>/chats/`)
  - Various config files in `Storage` class

### Key Files to Modify
1. `packages/core/src/config/storage.ts` - Add database configuration
2. `packages/core/src/services/chatRecordingService.ts` - Store conversations in PostgreSQL
3. `package.json` - Add `pg` dependency
4. Create new database service

### Database Schema (to be created)
- `conversations` - Store conversation history
- `messages` - Store individual messages
- `sessions` - Store session metadata

## Implementation Plan

### Step 1: Add PostgreSQL dependency
- Add `pg` package to root `package.json`
- Add `dotenv` for environment variable handling

### Step 2: Create Database Service
- Create `packages/core/src/services/databaseService.ts`
- Implement connection pooling
- Create migration scripts
- Implement CRUD operations for conversations

### Step 3: Update Storage Configuration
- Add `DATABASE_URL` environment variable support
- Add fallback to file-based storage if database unavailable

### Step 4: Integrate with ChatRecordingService
- Update to use PostgreSQL for storing conversations
- Maintain backward compatibility with file storage

### Step 5: Environment Setup
- Document required environment variables
- Create `.env.example` file

## Dependent Files
- `packages/core/package.json`
- `packages/core/src/services/chatRecordingService.ts`
- `packages/core/src/config/storage.ts`

## Followup Steps
1. Install dependencies
2. Test database connection
3. Run migrations
4. Test conversation storage with PostgreSQL

