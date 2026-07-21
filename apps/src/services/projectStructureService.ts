import * as fs from 'fs';
import * as path from 'path';
import { BASE, PROMPTS_DIR } from '../models';

const DEFAULT_PROJECT_STRUCTURE = `# 前端目录（Vue3 + TypeScript + Pinia）
src/
├── api/            # API 接口定义层（只写 URL 和 method，每个业务模块一个文件）
├── mock/
│   ├── index.js        # 路由映射表 (mockDataMap)，所有 Mock 路由在此注册
│   ├── interceptor.js  # axios 拦截器（Mock 核心开关）
│   └── modules/        # Mock 数据实现，与 api/ 一一对应
├── stores/         # Pinia 状态层（可选，用于跨组件共享数据，内部仍调用 api/）
├── views/          # 页面
├── components/     # 公共组件（图表、顶栏、面板等）
├── router/
│   └── index.ts    # 路由配置（含权限守卫）
└── utils/
    └── request.ts  # axios 封装（含 Mock 拦截接入点）

# 后端目录（SpringBoot DDD 分层，包名以 [基础包名] 为前缀）
[基础包名]/
├── application/
│   ├── adapter/
│   │   ├── api/
│   │   ├── consumer/
│   │   └── scheduler/
│   ├── service/
│   │   ├── XxxAppService.java
│   │   └── process/
│   │       └── XxxProcess.java
│   ├── repository/
│   ├── dto/
│   ├── converter/
│   ├── external/
│   └── error/
├── domain/
│   └── [聚合根]/
│       ├── entity/
│       ├── event/
│       ├── repository/
│       ├── constants/
│       ├── enums/
│       ├── error/
│       └── properties/
├── infrastructure/
│   └── [聚合根]/
│       └── repository/
│           ├── dao/
│           ├── cache/
│           ├── storage/
│           ├── dataObject/
│           └── converter/
├── external/
│   └── [外部中心名称]/
│       ├── dto/
│       ├── converter/
│       ├── feign/
│       ├── error/
│       └── properties/
└── boot/
    └── XxxApplication.java
`;

export class ProjectStructureService {
    private monorepoMainDir: string | undefined;

    constructor(
        private readonly workspaceRoot: string,
        private readonly extensionPath: string,
    ) {}

    /**
     * In monorepo mode, set to repos/mono-main so that project-structure.md
     * lives inside the git-managed worktree rather than the untracked workspace docs/.
     */
    setMonorepoMainDir(dir: string | undefined): void {
        this.monorepoMainDir = dir;
    }

    private getStructureRoot(): string {
        return this.monorepoMainDir || this.workspaceRoot;
    }

    getRootStructureFilePath(): string {
        return path.join(this.getStructureRoot(), 'docs', 'project-structure.md');
    }

    getIterationStructureFilePath(iterDir: string): string {
        return path.join(iterDir, 'docs', 'project-structure.md');
    }

    getPreviewStructureFilePath(): string {
        return path.join(this.getStructureRoot(), 'docs', 'project-structure.preview.md');
    }

    private getLegacyRootStructureFilePath(): string {
        return path.join(this.workspaceRoot, BASE, 'project-structure.md');
    }

    /**
     * Ensure the root project-structure.md baseline exists and report which source produced it.
     * The returned `source` is a single, mutually-exclusive origin of the final document:
     *   - 'custom'   : written from user-provided custom structure
     *   - 'existing' : an existing non-empty root document was kept
     *   - 'detected' : content derived from the real workspace directory scan
     *   - 'default'  : fell back to the built-in default template
     * (The 'detected' branch wiring is implemented in a later task; this signature declares the contract.)
     */
    ensureBaseline(customProjectStructure: string): { source: 'custom' | 'existing' | 'detected' | 'default'; filePath: string } {
        const custom = (customProjectStructure || '').trim();
        if (custom) {
            this.writeRootStructure(custom);
            return { source: 'custom', filePath: this.getRootStructureFilePath() };
        }

        const existing = this.readRootStructure();
        if (existing) {
            if (!fs.existsSync(this.getRootStructureFilePath())) {
                this.writeRootStructure(existing);
            }
            return { source: 'existing', filePath: this.getRootStructureFilePath() };
        }

        this.writeRootStructure(this.getDefaultStructure());
        return { source: 'default', filePath: this.getRootStructureFilePath() };
    }

    readRootStructure(): string {
        const filePath = this.getRootStructureFilePath();
        if (fs.existsSync(filePath)) {
            try {
                return fs.readFileSync(filePath, 'utf8').trim();
            } catch {
                return '';
            }
        }

        const legacyPath = this.getLegacyRootStructureFilePath();
        if (!fs.existsSync(legacyPath)) {
            return '';
        }
        try {
            return fs.readFileSync(legacyPath, 'utf8').trim();
        } catch {
            return '';
        }
    }

    writeRootStructure(content: string): void {
        const filePath = this.getRootStructureFilePath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${content.trim()}\n`, 'utf8');
    }

    writePreviewStructure(content: string): string {
        const filePath = this.getPreviewStructureFilePath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${content.trim()}\n`, 'utf8');
        return filePath;
    }

    applyPreviewToRoot(): boolean {
        const previewPath = this.getPreviewStructureFilePath();
        if (!fs.existsSync(previewPath)) {
            return false;
        }
        try {
            const content = fs.readFileSync(previewPath, 'utf8').trim();
            if (!content) {
                return false;
            }
            this.writeRootStructure(content);
            return true;
        } catch {
            return false;
        }
    }

    copyRootStructureToIteration(iterDir: string): void {
        const rootContent = this.readRootStructure();
        if (!rootContent) {
            return;
        }
        const targetPath = this.getIterationStructureFilePath(iterDir);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, `${rootContent}\n`, 'utf8');
    }

    detectStructureFromWorkspace(): { content: string; detected: boolean; summary: string } {
        const frontend = this.findFrontendProject();
        const backend = this.findBackendProject();

        if (!frontend && !backend) {
            return {
                content: this.getDefaultStructure(),
                detected: false,
                summary: '未检测到前后端项目，已回退默认结构',
            };
        }

        const sections: string[] = [];
        const summaryParts: string[] = [];

        if (frontend) {
            sections.push(this.buildFrontendConciseTree(frontend));
            summaryParts.push(`前端: ${frontend.kind === 'vue3' ? 'Vue3' : 'React'}`);
        }

        if (backend) {
            sections.push(this.buildBackendConciseTree(backend));
            summaryParts.push(`后端: ${backend.kind === 'java-ddd' ? 'Java' : 'Node.js'}`);
        }

        return {
            content: sections.join('\n\n'),
            detected: true,
            summary: summaryParts.join(' | '),
        };
    }

    getDefaultStructure(): string {
        const bundledCandidates = [
            path.join(this.extensionPath, BASE, PROMPTS_DIR, 'default_project_structure.md'),
            path.join(this.extensionPath, PROMPTS_DIR, 'default_project_structure.md'),
        ];
        for (const bundled of bundledCandidates) {
            if (!fs.existsSync(bundled)) {
                continue;
            }
            try {
                const content = fs.readFileSync(bundled, 'utf8').trim();
                if (content) {
                    return content;
                }
            } catch {
                // ignore bundled file read failures and try next fallback.
            }
        }
        return DEFAULT_PROJECT_STRUCTURE.trim();
    }

    // ── Detection helpers ──────────────────────────────────────────────

    private findFrontendProject(): { root: string; kind: 'vue3' | 'react' } | null {
        const candidates = [
            this.workspaceRoot,
            path.join(this.workspaceRoot, 'repos', 'frontend-main'),
            path.join(this.workspaceRoot, 'frontend'),
            // Monorepo layout: dedicated main clone at repos/mono-main, with an apps/ folder.
            path.join(this.workspaceRoot, 'repos', 'mono-main', 'apps'),
            path.join(this.workspaceRoot, 'repos', 'mono-main'),
            path.join(this.workspaceRoot, 'apps'),
        ];
        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) {
                continue;
            }
            const srcDir = path.join(candidate, 'src');
            const pkg = path.join(candidate, 'package.json');
            if (!fs.existsSync(srcDir) || !fs.existsSync(pkg)) {
                continue;
            }
            if (this.containsVueFile(srcDir, 3)) {
                return { root: candidate, kind: 'vue3' };
            }
            if (this.containsReactDependency(pkg) || this.containsReactFile(srcDir, 3)) {
                return { root: candidate, kind: 'react' };
            }
        }
        return null;
    }

    private findBackendProject(): { root: string; kind: 'java-ddd' | 'node' } | null {
        const candidates = [
            path.join(this.workspaceRoot, 'repos', 'backend-main'),
            path.join(this.workspaceRoot, 'backend'),
            this.workspaceRoot,
            // Monorepo layout: dedicated main clone at repos/mono-main, with an apps/ folder.
            path.join(this.workspaceRoot, 'repos', 'mono-main', 'apps'),
            path.join(this.workspaceRoot, 'repos', 'mono-main'),
            path.join(this.workspaceRoot, 'apps'),
        ];
        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) {
                continue;
            }
            if (this.isJavaBackendProject(candidate)) {
                return { root: candidate, kind: 'java-ddd' };
            }
            const nodePkg = path.join(candidate, 'package.json');
            const nodeSrc = path.join(candidate, 'src');
            if (fs.existsSync(nodePkg) && (fs.existsSync(nodeSrc) || fs.existsSync(path.join(candidate, 'app')))) {
                if (this.containsNodeServerHints(nodePkg)) {
                    return { root: candidate, kind: 'node' };
                }
            }
        }
        return null;
    }

    private isJavaBackendProject(candidate: string): boolean {
        const javaDir = path.join(candidate, 'src', 'main', 'java');
        const hasMavenBuild = fs.existsSync(path.join(candidate, 'pom.xml'));
        const hasGradleBuild = fs.existsSync(path.join(candidate, 'build.gradle')) || fs.existsSync(path.join(candidate, 'build.gradle.kts'));
        if (fs.existsSync(javaDir) && (hasMavenBuild || hasGradleBuild)) {
            return true;
        }

        const mavenModules = this.resolveMavenModulePaths(candidate);
        if (mavenModules.length > 0) {
            for (const modulePath of mavenModules) {
                const moduleRoot = path.join(candidate, modulePath);
                const moduleJavaDir = path.join(moduleRoot, 'src', 'main', 'java');
                const modulePom = path.join(moduleRoot, 'pom.xml');
                if (fs.existsSync(modulePom) && fs.existsSync(moduleJavaDir)) {
                    return true;
                }
            }
        }

        // Fallback: scan one level for common Java module shape.
        for (const child of this.listSubDirs(candidate, 40)) {
            const childRoot = path.join(candidate, child);
            const childJavaDir = path.join(childRoot, 'src', 'main', 'java');
            const childPom = path.join(childRoot, 'pom.xml');
            const childGradle = path.join(childRoot, 'build.gradle');
            const childGradleKts = path.join(childRoot, 'build.gradle.kts');
            if (fs.existsSync(childJavaDir) && (fs.existsSync(childPom) || fs.existsSync(childGradle) || fs.existsSync(childGradleKts))) {
                return true;
            }
        }

        return false;
    }

    private resolveMavenModulePaths(candidate: string): string[] {
        const pomPath = path.join(candidate, 'pom.xml');
        if (!fs.existsSync(pomPath)) {
            return [];
        }
        try {
            const raw = fs.readFileSync(pomPath, 'utf8');
            return Array.from(raw.matchAll(/<module>\s*([^<\n\r]+)\s*<\/module>/gi), (match: RegExpMatchArray) => (match[1] || '').trim())
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    private containsVueFile(dir: string, depth: number): boolean {
        if (depth < 0 || !fs.existsSync(dir)) {
            return false;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith('.vue')) {
                return true;
            }
            if (entry.isDirectory() && this.containsVueFile(fullPath, depth - 1)) {
                return true;
            }
        }
        return false;
    }

    private containsReactFile(dir: string, depth: number): boolean {
        if (depth < 0 || !fs.existsSync(dir)) {
            return false;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && /\.(jsx|tsx)$/.test(entry.name)) {
                return true;
            }
            if (entry.isDirectory() && this.containsReactFile(fullPath, depth - 1)) {
                return true;
            }
        }
        return false;
    }

    private containsReactDependency(pkgPath: string): boolean {
        try {
            const pkgRaw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = {
                ...(pkgRaw.dependencies || {}),
                ...(pkgRaw.devDependencies || {}),
            };
            return Boolean(deps.react || deps['react-dom'] || deps.next);
        } catch {
            return false;
        }
    }

    private containsNodeServerHints(pkgPath: string): boolean {
        try {
            const pkgRaw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = {
                ...(pkgRaw.dependencies || {}),
                ...(pkgRaw.devDependencies || {}),
            };
            return Boolean(deps.express || deps.koa || deps.fastify || deps['@nestjs/core']);
        } catch {
            return false;
        }
    }

    private listSubDirs(dir: string, max: number): string[] {
        if (!fs.existsSync(dir)) {
            return ['api', 'stores', 'views', 'components', 'router', 'utils'];
        }
        const dirs = fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry: fs.Dirent) => entry.isDirectory())
            .map((entry: fs.Dirent) => entry.name)
            .sort();
        return dirs.length > 0 ? dirs.slice(0, max) : ['api', 'stores', 'views', 'components', 'router', 'utils'];
    }

    private pickJavaBasePackage(javaDir: string): string {
        if (!fs.existsSync(javaDir)) {
            return '[基础包名]';
        }
        const first = fs.readdirSync(javaDir, { withFileTypes: true }).find((entry: fs.Dirent) => entry.isDirectory());
        if (!first) {
            return '[基础包名]';
        }
        const secondPath = path.join(javaDir, first.name);
        const second = fs.readdirSync(secondPath, { withFileTypes: true }).find((entry: fs.Dirent) => entry.isDirectory());
        if (!second) {
            return first.name;
        }
        return `${first.name}/${second.name}`;
    }

    private pickJavaBasePackageForBackend(backendRoot: string, modules: string[]): string {
        const rootJavaDir = path.join(backendRoot, 'src', 'main', 'java');
        const rootPackage = this.pickJavaBasePackage(rootJavaDir);
        if (rootPackage !== '[基础包名]') {
            return rootPackage;
        }

        for (const modulePath of modules) {
            const moduleJavaDir = path.join(backendRoot, modulePath, 'src', 'main', 'java');
            const modulePackage = this.pickJavaBasePackage(moduleJavaDir);
            if (modulePackage !== '[基础包名]') {
                return modulePackage;
            }
        }

        return '[基础包名]';
    }

    private inferJavaArchitectureStyle(
        backendRoot: string,
        modules: string[],
        packageHint: string,
    ): 'ddd' | 'layered' | 'mixed' {
        const packageSegments = packageHint === '[基础包名]' ? [] : packageHint.split('/');
        const roots: string[] = [];

        if (modules.length > 0) {
            for (const modulePath of modules) {
                roots.push(path.join(backendRoot, modulePath, 'src', 'main', 'java'));
            }
        } else {
            roots.push(path.join(backendRoot, 'src', 'main', 'java'));
        }

        let dddSignals = 0;
        let layeredSignals = 0;
        const checkDirs = (base: string, dirs: string[]): number => dirs.reduce((acc, dir) => acc + (fs.existsSync(path.join(base, dir)) ? 1 : 0), 0);

        for (const javaRoot of roots) {
            const root = packageSegments.length > 0 ? path.join(javaRoot, ...packageSegments) : javaRoot;
            dddSignals += checkDirs(root, ['application', 'domain', 'infrastructure']);
            layeredSignals += checkDirs(root, ['controller', 'service', 'repository', 'mapper', 'dao']);
        }

        if (dddSignals >= 3 && layeredSignals <= 1) {
            return 'ddd';
        }
        if (layeredSignals >= 2 && dddSignals <= 1) {
            return 'layered';
        }
        return dddSignals === 0 && layeredSignals === 0 ? 'layered' : 'mixed';
    }

    private toWorkspaceRelative(absPath: string): string {
        const rel = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
        return rel || '.';
    }

    // ── Concise tree builders ──────────────────────────────────────────

    private buildFrontendConciseTree(frontend: { root: string; kind: 'vue3' | 'react' }): string {
        const srcDir = path.join(frontend.root, 'src');
        const relRoot = this.toWorkspaceRelative(frontend.root);
        const srcChildren = this.listSubDirs(srcDir, 15);
        const label = frontend.kind === 'vue3' ? 'Vue3 + TypeScript' : 'React + TypeScript';

        const lines: string[] = [`# 前端目录（${label}）`, `${relRoot}/src/`];
        srcChildren.forEach((name, i) => {
            const isLast = i === srcChildren.length - 1;
            const prefix = isLast ? '└──' : '├──';
            const role = this.inferFrontendDirRoleBrief(name);
            const padding = ' '.repeat(Math.max(1, 16 - name.length));
            lines.push(role
                ? `${prefix} ${name}/${padding}# ${role}`
                : `${prefix} ${name}/`);
        });
        return lines.join('\n');
    }

    private buildBackendConciseTree(backend: { root: string; kind: 'java-ddd' | 'node' }): string {
        const relRoot = this.toWorkspaceRelative(backend.root);

        if (backend.kind === 'node') {
            return this.buildNodeBackendTree(backend.root, relRoot);
        }
        return this.buildJavaBackendTree(backend.root, relRoot);
    }

    private buildNodeBackendTree(backendRoot: string, relRoot: string): string {
        const srcDir = path.join(backendRoot, 'src');
        const srcChildren = this.listSubDirs(srcDir, 15);
        const lines: string[] = [`# 后端目录（Node.js）`, `${relRoot}/src/`];
        srcChildren.forEach((name, i) => {
            const isLast = i === srcChildren.length - 1;
            const prefix = isLast ? '└──' : '├──';
            const role = this.inferNodeDirRoleBrief(name);
            const padding = ' '.repeat(Math.max(1, 16 - name.length));
            lines.push(role
                ? `${prefix} ${name}/${padding}# ${role}`
                : `${prefix} ${name}/`);
        });
        return lines.join('\n');
    }

    private buildJavaBackendTree(backendRoot: string, relRoot: string): string {
        const modules = this.resolveMavenModulePaths(backendRoot);
        const isMultiModule = modules.length > 0;
        const packageHint = this.pickJavaBasePackageForBackend(backendRoot, modules);
        const javaStyle = this.inferJavaArchitectureStyle(backendRoot, modules, packageHint || '[基础包名]');
        const styleLabel = javaStyle === 'ddd'
            ? 'SpringBoot DDD 分层'
            : javaStyle === 'layered'
                ? 'SpringBoot 分层'
                : 'SpringBoot 混合分层';
        const pkgDisplay = packageHint !== '[基础包名]'
            ? packageHint.replace(/\//g, '.')
            : '[基础包名]';

        if (!isMultiModule) {
            return this.buildJavaSingleModuleTree(backendRoot, relRoot, packageHint, pkgDisplay, styleLabel, javaStyle);
        }
        return this.buildJavaMultiModuleTree(backendRoot, relRoot, modules, pkgDisplay, styleLabel, javaStyle);
    }

    private buildJavaSingleModuleTree(
        backendRoot: string,
        relRoot: string,
        packageHint: string,
        pkgDisplay: string,
        styleLabel: string,
        javaStyle: 'ddd' | 'layered' | 'mixed',
    ): string {
        const javaDir = path.join(backendRoot, 'src', 'main', 'java');
        const pkgDir = packageHint !== '[基础包名]'
            ? path.join(javaDir, ...packageHint.split('/'))
            : javaDir;

        const lines: string[] = [`# 后端目录（${styleLabel}，包名前缀 ${pkgDisplay}）`, `${pkgDisplay}/`];
        const leafDirs = this.listJavaLeafPackageDirs(pkgDir);

        if (leafDirs.length > 0) {
            this.appendTreeLines(lines, leafDirs, '', (name) => this.inferJavaDirRoleBrief(path.basename(name), javaStyle));
        } else {
            // No detected dirs, output convention tree based on style
            lines.push(...this.getJavaConventionTree(javaStyle));
        }
        return lines.join('\n');
    }

    private buildJavaMultiModuleTree(
        backendRoot: string,
        relRoot: string,
        modules: string[],
        pkgDisplay: string,
        styleLabel: string,
        javaStyle: 'ddd' | 'layered' | 'mixed',
    ): string {
        const lines: string[] = [`# 后端目录（${styleLabel}，多模块）`, `${relRoot}/`];

        modules.forEach((modulePath, mi) => {
            const isLastModule = mi === modules.length - 1;
            const modulePrefix = isLastModule ? '└──' : '├──';
            const childIndent = isLastModule ? '    ' : '│   ';
            const moduleName = path.basename(modulePath);
            const moduleRole = this.inferJavaModuleRoleBrief(moduleName);
            const modulePadding = ' '.repeat(Math.max(1, 24 - moduleName.length));

            lines.push(moduleRole
                ? `${modulePrefix} ${moduleName}/${modulePadding}# ${moduleRole}`
                : `${modulePrefix} ${moduleName}/`);

            // List actual packages under this module
            const moduleRoot = path.join(backendRoot, modulePath);
            const javaDir = path.join(moduleRoot, 'src', 'main', 'java');
            const modulePackageHint = this.pickJavaBasePackage(javaDir);
            const modulePkgDisplay = modulePackageHint !== '[基础包名]'
                ? modulePackageHint.replace(/\//g, '.')
                : pkgDisplay;
            const pkgSegments = modulePackageHint !== '[基础包名]' ? modulePackageHint.split('/') : [];
            const pkgDir = pkgSegments.length > 0 ? path.join(javaDir, ...pkgSegments) : javaDir;

            if (!fs.existsSync(pkgDir)) {
                return;
            }

            const leafDirs = this.listJavaLeafPackageDirs(pkgDir);
            if (leafDirs.length === 0) {
                return;
            }

            lines.push(`${childIndent}└── ${modulePkgDisplay}/`);
            const pkgIndent = childIndent + '    ';
            this.appendTreeLines(lines, leafDirs, pkgIndent, (name) => this.inferJavaDirRoleBrief(path.basename(name), javaStyle));
        });

        return lines.join('\n');
    }

    private appendTreeLines(
        lines: string[],
        dirs: string[],
        indent: string,
        roleFn: (name: string) => string,
    ): void {
        dirs.forEach((name, i) => {
            const isLast = i === dirs.length - 1;
            const prefix = isLast ? '└──' : '├──';
            const role = roleFn(name);
            const padding = ' '.repeat(Math.max(1, 20 - name.length));
            lines.push(role
                ? `${indent}${prefix} ${name}/${padding}# ${role}`
                : `${indent}${prefix} ${name}/`);
        });
    }

    private listJavaPackageDirs(pkgDir: string): string[] {
        if (!fs.existsSync(pkgDir)) {
            return [];
        }
        try {
            return fs.readdirSync(pkgDir, { withFileTypes: true })
                .filter((e: fs.Dirent) => e.isDirectory())
                .map((e: fs.Dirent) => e.name)
                .sort();
        } catch {
            return [];
        }
    }

    private listJavaLeafPackageDirs(pkgDir: string, maxLeaves: number = 36, maxDepth: number = 8): string[] {
        if (!fs.existsSync(pkgDir)) {
            return [];
        }

        const leaves: string[] = [];
        const visit = (dir: string, rel: string[], depth: number): void => {
            if (depth > maxDepth || leaves.length >= maxLeaves) {
                return;
            }
            let childDirs: string[] = [];
            try {
                childDirs = fs.readdirSync(dir, { withFileTypes: true })
                    .filter((e: fs.Dirent) => e.isDirectory())
                    .map((e: fs.Dirent) => e.name)
                    .sort();
            } catch {
                return;
            }

            if (childDirs.length === 0) {
                if (rel.length > 0) {
                    leaves.push(rel.join('/'));
                }
                return;
            }

            childDirs.forEach((name) => visit(path.join(dir, name), [...rel, name], depth + 1));
        };

        visit(pkgDir, [], 0);
        return leaves;
    }

    private getJavaConventionTree(javaStyle: 'ddd' | 'layered' | 'mixed'): string[] {
        if (javaStyle === 'ddd') {
            return [
                '├── application/            # 应用层（服务编排、DTO、适配器）',
                '├── domain/                 # 领域层（实体、事件、仓储接口）',
                '├── infrastructure/         # 基础设施层（DAO、缓存、存储实现）',
                '├── external/               # 外部对接层（Feign、防腐转换）',
                '└── boot/                   # 启动层',
            ];
        }
        return [
            '├── controller/             # 接口入口（参数校验/鉴权）',
            '├── service/                # 业务编排与规则',
            '├── repository/             # 数据访问抽象',
            '├── mapper/                 # 持久化映射',
            '├── entity/                 # 领域对象',
            '├── dto/                    # 请求/响应对象',
            '└── boot/                   # 启动装配',
        ];
    }

    // ── Role inference (brief, one-line) ───────────────────────────────

    private inferFrontendDirRoleBrief(name: string): string {
        const n = name.toLowerCase();
        const map: Record<string, string> = {
            api: 'API 接口定义',
            apis: 'API 接口定义',
            mock: 'Mock 数据',
            mocks: 'Mock 数据',
            store: '状态管理',
            stores: '状态管理',
            view: '页面',
            views: '页面',
            page: '页面',
            pages: '页面',
            component: '公共组件',
            components: '公共组件',
            router: '路由配置',
            util: '通用工具',
            utils: '通用工具',
            helper: '工具函数',
            helpers: '工具函数',
            type: 'TS 类型定义',
            types: 'TS 类型定义',
            config: '运行配置',
            constant: '常量与枚举',
            constants: '常量与枚举',
            static: '静态资源',
            asset: '静态资源',
            assets: '静态资源',
            style: '样式文件',
            styles: '样式文件',
            layout: '布局组件',
            layouts: '布局组件',
            plugin: '插件',
            plugins: '插件',
            directive: '自定义指令',
            directives: '自定义指令',
            composable: '组合式函数',
            composables: '组合式函数',
            hook: '自定义 Hook',
            hooks: '自定义 Hook',
            service: '业务服务',
            services: '业务服务',
            locale: '国际化',
            locales: '国际化',
            i18n: '国际化',
            subpackages: '业务子域模块',
            module: '业务模块',
            modules: '业务模块',
        };
        return map[n] || '';
    }

    private inferNodeDirRoleBrief(name: string): string {
        const n = name.toLowerCase();
        const map: Record<string, string> = {
            controller: '路由控制器',
            controllers: '路由控制器',
            service: '业务服务',
            services: '业务服务',
            model: '数据模型',
            models: '数据模型',
            middleware: '中间件',
            middlewares: '中间件',
            route: '路由定义',
            routes: '路由定义',
            util: '通用工具',
            utils: '通用工具',
            config: '配置',
            type: '类型定义',
            types: '类型定义',
            domain: '领域模型',
            infrastructure: '基础设施（DB/缓存）',
            repository: '数据访问',
            interface: '接口入口',
            interfaces: '接口入口',
            shared: '公共模块',
        };
        return map[n] || '';
    }

    private inferJavaDirRoleBrief(name: string, javaStyle: 'ddd' | 'layered' | 'mixed'): string {
        const n = name.toLowerCase();
        if (javaStyle === 'ddd') {
            const map: Record<string, string> = {
                application: '应用层（服务编排、DTO、适配器）',
                domain: '领域层（实体、事件、仓储接口）',
                infrastructure: '基础设施层（DAO、缓存、存储）',
                external: '外部对接层（Feign、防腐转换）',
                boot: '启动层',
                adapter: '适配器（API/MQ/定时任务入口）',
                service: '应用服务',
                dto: '请求/响应对象',
                converter: '对象转换器',
                repository: '仓储',
                entity: '实体',
                event: '领域事件',
                enums: '枚举',
                constants: '常量',
                error: '错误码',
                process: '编排流程',
                consumer: 'MQ 消费者',
                scheduler: '定时任务',
                api: 'REST 入口',
                properties: '配置属性',
                dao: 'DAO',
                cache: '缓存',
                storage: '对象存储',
                dataobject: '持久化对象',
                feign: 'Feign 客户端',
            };
            return map[n] || '';
        }
        const map: Record<string, string> = {
            controller: 'REST 控制器',
            service: '业务服务',
            repository: '数据访问',
            mapper: '持久化映射',
            dao: 'DAO',
            entity: '领域实体',
            model: '数据模型',
            dto: '请求/响应对象',
            vo: '视图对象',
            config: '配置',
            boot: '启动装配',
            integration: '外部系统适配',
            external: '外部系统适配',
            client: '外部客户端',
            feign: 'Feign 客户端',
            job: '定时任务',
            consumer: 'MQ 消费者',
            listener: '事件监听',
            enums: '枚举',
            constants: '常量',
            error: '错误码',
            exception: '异常定义',
            util: '工具类',
            utils: '工具类',
            common: '公共模块',
            impl: '实现类',
            interceptor: '拦截器',
            filter: '过滤器',
            aspect: '切面',
        };
        return map[n] || '';
    }

    private inferJavaModuleRoleBrief(moduleName: string): string {
        const n = moduleName.toLowerCase();
        if (/service|core|domain/.test(n)) {
            return '业务核心模块';
        }
        if (/web|api|gateway/.test(n)) {
            return '接口入口模块';
        }
        if (/start|boot|app/.test(n)) {
            return '启动装配模块';
        }
        if (/common|shared|base/.test(n)) {
            return '公共基础模块';
        }
        if (/infra|infrastructure|dal/.test(n)) {
            return '基础设施模块';
        }
        if (/client|integration|external/.test(n)) {
            return '外部对接模块';
        }
        return '';
    }
}
