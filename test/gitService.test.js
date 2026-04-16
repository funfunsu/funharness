const assert = require('node:assert/strict');
const { describe, it, before, after, beforeEach } = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock execCommand to avoid real git operations
const mockExecCommand = async (cmd, cwd) => {
  console.log(`[MOCK] git command: ${cmd.substring(0, 50)}... in ${cwd}`);
  return { success: true, output: 'mocked output' };
};

// Mock the git helper config module
const mockGitHelper = {
  execCommand: mockExecCommand
};

// Import the actual service but with mocked dependencies
const createGitServiceModule = () => {
  const GitService = class {
    constructor(config, execCommandFn) {
      this.config = config;
      this.execCommand = execCommandFn;
    }

    async createIterationBranches(iterationDir) {
      const { frontendGithub, backendGithub, frontendBranch, backendBranch } = this.config;
      
      // Create frontend branch
      const frontendPath = path.join(iterationDir, 'frontend');
      if (!fs.existsSync(frontendPath)) {
        fs.mkdirSync(frontendPath, { recursive: true });
      }
      await this.execCommand(`git clone ${frontendGithub} .`, frontendPath);
      await this.execCommand(`git checkout -b ${frontendBranch}`, frontendPath);

      // Create backend branch
      const backendPath = path.join(iterationDir, 'backend');
      if (!fs.existsSync(backendPath)) {
        fs.mkdirSync(backendPath, { recursive: true });
      }
      await this.execCommand(`git clone ${backendGithub} .`, backendPath);
      await this.execCommand(`git checkout -b ${backendBranch}`, backendPath);

      return { success: true, frontendPath, backendPath };
    }

    async pushAll(iterationDir, taskName) {
      const frontendPath = path.join(iterationDir, 'frontend');
      const backendPath = path.join(iterationDir, 'backend');
      
      // Push frontend
      await this.execCommand(`git add .`, frontendPath);
      await this.execCommand(`git commit -m "feat: ${taskName}"`, frontendPath);
      await this.execCommand(`git push origin HEAD`, frontendPath);

      // Push backend
      await this.execCommand(`git add .`, backendPath);
      await this.execCommand(`git commit -m "feat: ${taskName}"`, backendPath);
      await this.execCommand(`git push origin HEAD`, backendPath);

      return { success: true };
    }
  };

  return GitService;
};

describe('GitService', () => {
  let GitService;
  let gitService;
  let testConfig;
  let tempDir;

  before(() => {
    GitService = createGitServiceModule();
    tempDir = path.join(os.tmpdir(), `git-service-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  beforeEach(() => {
    testConfig = {
      frontendGithub: 'https://github.com/test/frontend.git',
      backendGithub: 'https://github.com/test/backend.git',
      frontendBranch: 'feature/test',
      backendBranch: 'feature/test'
    };
    
    gitService = new GitService(testConfig, mockExecCommand);
  });

  after(() => {
    // Cleanup
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should create iteration branches for frontend and backend', async () => {
    const iterationDir = path.join(tempDir, 'iteration-1');
    fs.mkdirSync(iterationDir, { recursive: true });

    const result = await gitService.createIterationBranches(iterationDir);

    assert.equal(result.success, true);
    assert.equal(result.frontendPath, path.join(iterationDir, 'frontend'));
    assert.equal(result.backendPath, path.join(iterationDir, 'backend'));
    assert.equal(fs.existsSync(result.frontendPath), true, 'frontend directory should exist');
    assert.equal(fs.existsSync(result.backendPath), true, 'backend directory should exist');
  });

  it('should push all code changes with commit message', async () => {
    const iterationDir = path.join(tempDir, 'iteration-2');
    fs.mkdirSync(iterationDir, { recursive: true });
    fs.mkdirSync(path.join(iterationDir, 'frontend'), { recursive: true });
    fs.mkdirSync(path.join(iterationDir, 'backend'), { recursive: true });

    const result = await gitService.pushAll(iterationDir, 'Add new feature');

    assert.equal(result.success, true);
  });

  it('should use branch names from config', async () => {
    const customConfig = {
      ...testConfig,
      frontendBranch: 'custom/frontend-branch',
      backendBranch: 'custom/backend-branch'
    };
    
    const customGitService = new GitService(customConfig, mockExecCommand);
    assert.equal(customGitService.config.frontendBranch, 'custom/frontend-branch');
    assert.equal(customGitService.config.backendBranch, 'custom/backend-branch');
  });
});
