const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

// Mock PROMPT_CONFIGS
const PROMPT_CONFIGS = {
  design_agent: { name: 'design_agent', template: 'Design the system architecture for {{PROJECT_NAME}}' },
  dev_agent: { name: 'dev_agent', template: 'Implement {{TASK_NAME}} for {{PROJECT_NAME}}' },
  qa_agent: { name: 'qa_agent', template: 'Test {{TASK_NAME}} thoroughly' },
  requirements_agent: { name: 'requirements_agent', template: 'Gather requirements for {{FEATURE}}' },
  tasks_agent: { name: 'tasks_agent', template: 'Break down {{PROJECT_NAME}} into tasks' }
};

const AGENT_DEFINITIONS = {
  design: { name: 'design_agent', description: 'Design and architecture' },
  dev: { name: 'dev_agent', description: 'Development and coding' },
  qa: { name: 'qa_agent', description: 'Quality assurance' },
  requirements: { name: 'requirements_agent', description: 'Requirements gathering' },
  tasks: { name: 'tasks_agent', description: 'Task breakdown' }
};

// Create PromptService class for testing
class PromptService {
  constructor(promptConfigs = {}, agentDefinitions = {}) {
    this.promptConfigs = { ...PROMPT_CONFIGS, ...promptConfigs };
    this.agentDefinitions = { ...AGENT_DEFINITIONS, ...agentDefinitions };
  }

  /**
   * Get all agent definitions
   */
  getAgentDefinitions() {
    return Object.values(this.agentDefinitions);
  }

  /**
   * Get prompt template by agent name
   */
  getPromptTemplate(agentName) {
    const config = Object.values(this.promptConfigs).find(c => c.name === agentName);
    return config ? config.template : null;
  }

  /**
   * Render template with variable substitution
   */
  renderTemplate(template, variables = {}) {
    let rendered = template;
    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replace(`{{${key}}}`, String(value));
    }
    return rendered;
  }

  /**
   * Get rendered prompt for an agent with variables
   */
  getRenderedPrompt(agentName, variables = {}) {
    const template = this.getPromptTemplate(agentName);
    if (!template) return null;
    return this.renderTemplate(template, variables);
  }

  /**
   * Ensure all project prompts are configured
   */
  ensureProjectPrompts(projectName) {
    const prompts = {};
    for (const [key, agent] of Object.entries(this.agentDefinitions)) {
      const template = this.getPromptTemplate(agent.name);
      if (template) {
        prompts[key] = this.renderTemplate(template, { 
          PROJECT_NAME: projectName,
          TASK_NAME: `task-${key}`,
          FEATURE: `feature-${key}`
        });
      }
    }
    return prompts;
  }

  /**
   * Restore or validate agent prompt configuration
   */
  restoreAgentPrompt(agentName) {
    const agent = Object.values(this.agentDefinitions).find(a => a.name === agentName);
    const config = Object.values(this.promptConfigs).find(c => c.name === agentName);
    
    if (!agent || !config) {
      return { success: false, reason: 'Agent or config not found' };
    }

    return { 
      success: true, 
      agent: agent.name, 
      template: config.template,
      description: agent.description
    };
  }
}

describe('PromptService', () => {
  let promptService;

  beforeEach(() => {
    promptService = new PromptService();
  });

  it('should get all agent definitions', () => {
    const agents = promptService.getAgentDefinitions();
    
    assert.equal(agents.length, 5);
    const agentNames = agents.map(a => a.name).sort();
    assert.deepEqual(agentNames, [
      'design_agent',
      'dev_agent',
      'qa_agent',
      'requirements_agent',
      'tasks_agent'
    ]);
  });

  it('should retrieve prompt template by agent name', () => {
    const template = promptService.getPromptTemplate('dev_agent');
    
    assert.equal(template, 'Implement {{TASK_NAME}} for {{PROJECT_NAME}}');
  });

  it('should return null for unknown agent', () => {
    const template = promptService.getPromptTemplate('unknown_agent');
    
    assert.equal(template, null);
  });

  it('should render template with variable substitution', () => {
    const template = 'Hello {{NAME}}, welcome to {{PROJECT}}';
    const rendered = promptService.renderTemplate(template, {
      NAME: 'John',
      PROJECT: 'TestApp'
    });
    
    assert.equal(rendered, 'Hello John, welcome to TestApp');
  });

  it('should handle missing variables in template', () => {
    const template = 'Task: {{TASK_NAME}} for {{PROJECT_NAME}}';
    const rendered = promptService.renderTemplate(template, {
      PROJECT_NAME: 'MyApp'
    });
    
    assert.equal(rendered, 'Task: {{TASK_NAME}} for MyApp');
  });

  it('should get rendered prompt with variables', () => {
    const rendered = promptService.getRenderedPrompt('dev_agent', {
      TASK_NAME: 'Add authentication',
      PROJECT_NAME: 'SecureApp'
    });
    
    assert.equal(rendered, 'Implement Add authentication for SecureApp');
  });

  it('should return null for rendered prompt of unknown agent', () => {
    const rendered = promptService.getRenderedPrompt('nonexistent_agent', {});
    
    assert.equal(rendered, null);
  });

  it('should ensure all project prompts with substitutions', () => {
    const prompts = promptService.ensureProjectPrompts('FunHarness');
    
    assert.equal(Object.keys(prompts).length, 5);
    assert.match(prompts.dev, /FunHarness/);
    assert.match(prompts.design, /FunHarness/);
    assert.match(prompts.qa, /task-qa/);
    assert.match(prompts.requirements, /feature-requirements/);
  });

  it('should restore agent prompt configuration', () => {
    const result = promptService.restoreAgentPrompt('dev_agent');
    
    assert.equal(result.success, true);
    assert.equal(result.agent, 'dev_agent');
    assert.equal(result.description, 'Development and coding');
    assert.match(result.template, /{{TASK_NAME}}/);
  });

  it('should fail to restore unknown agent', () => {
    const result = promptService.restoreAgentPrompt('unknown_agent');
    
    assert.equal(result.success, false);
    assert.equal(result.reason, 'Agent or config not found');
  });

  it('should support custom prompt configs', () => {
    const customService = new PromptService({
      custom_prompt: { name: 'custom_prompt', template: 'Custom: {{VALUE}}' }
    });

    const template = customService.getPromptTemplate('custom_prompt');
    assert.equal(template, 'Custom: {{VALUE}}');

    const rendered = customService.getRenderedPrompt('custom_prompt', { VALUE: 'test' });
    assert.equal(rendered, 'Custom: test');
  });

  it('should handle empty variable substitution', () => {
    const rendered = promptService.getRenderedPrompt('dev_agent', {});
    
    assert.match(rendered, /{{TASK_NAME}}/);
    assert.match(rendered, /{{PROJECT_NAME}}/);
  });
});
