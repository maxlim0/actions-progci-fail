const fs = require('fs');

const MARKER = '<!-- ai-ci-helper -->';
const GITHUB_API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

// Читает входные параметры экшена из переменных окружения (INPUT_*),
// проверяет обязательные и подставляет значения по умолчанию.
function getInput(name, { required = false, defaultValue = '' } = {}) {
  const key = `INPUT_${name.toUpperCase().replace(/ /g, '_')}`;
  const value = process.env[key];
  if ((value === undefined || value.trim() === '') && required) {
    throw new Error(`Missing required input: ${name}`);
  }
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  return value.trim();
}

// Считывает JSON-файл события, с которым запустился GitHub Actions
// (нужно для извлечения контекста и последующего поиска PR).
function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set. This action must run on GitHub Actions.');
  }
  const raw = fs.readFileSync(eventPath, 'utf8');
  return JSON.parse(raw);
}

// Формирует базовые HTTP-заголовки для запросов к GitHub API
// с учётом версии, токена и user-agent.
function buildGitHubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'ai-ci-helper',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

// Универсальный запрос к GitHub API: отправляет HTTP-запрос, проверяет статус,
// возвращает JSON или текст в зависимости от заголовка ответа.
async function githubRequest(url, token, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildGitHubHeaders(token, headers),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed: ${url} ${response.status} ${response.statusText} - ${text}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

// Получает все jobs (задачи) конкретного workflow run, обходя страницы
// по 100 записей за раз.
async function fetchJobs(owner, repo, runId, token) {
  let page = 1;
  const jobs = [];
  while (true) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
    const data = await githubRequest(url, token);
    const pageJobs = data && Array.isArray(data.jobs) ? data.jobs : [];
    jobs.push(...pageJobs);
    if (!data || !data.jobs || data.jobs.length < 100) {
      break;
    }
    page += 1;
  }
  return jobs;
}

// Берёт информацию о конкретном workflow run (нужна его финальная оценка — success/failure).
async function fetchRun(owner, repo, runId, token) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}`;
  return githubRequest(url, token);
}

// Находит последний упавший job: смотрим, есть ли у него статус failure/timeout/cancelled
// или упавшие шаги; сортируем по времени завершения и берём самый свежий.
function pickFailedJob(jobs) {
  const failedJobs = (jobs || []).filter((job) => {
    const conclusion = String(job.conclusion || '').toLowerCase();
    const hasFailedStep = Array.isArray(job.steps)
      && job.steps.some((step) => FAILURE_CONCLUSIONS.has(String(step.conclusion || '').toLowerCase()));
    return FAILURE_CONCLUSIONS.has(conclusion) || hasFailedStep;
  });

  failedJobs.sort((a, b) => {
    const aTime = Date.parse(a.completed_at || a.started_at || 0);
    const bTime = Date.parse(b.completed_at || b.started_at || 0);
    return bTime - aTime;
  });

  return failedJobs[0] || null;
}

// Находит упавший шаг внутри выбранного job. Берём последний упавший шаг,
// чтобы анализировать самый свежий промах.
function pickFailedStep(job) {
  if (!job || !Array.isArray(job.steps)) {
    return null;
  }
  const failedSteps = job.steps.filter((step) => FAILURE_CONCLUSIONS.has(String(step.conclusion || '').toLowerCase()));
  return failedSteps[failedSteps.length - 1] || failedSteps[0] || null;
}

// Скачивает логи указанного job целиком (как текст). Требуются права actions:read.
async function fetchJobLogs(owner, repo, jobId, token) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
  return githubRequest(url, token);
}

// Обрезает лог до заданного количества строк с конца, чтобы не отправлять слишком много.
function trimLog(logText, maxLines) {
  const lines = String(logText || '').split(/\r?\n/);
  if (lines.length <= maxLines) {
    return { text: lines.join('\n'), total: lines.length };
  }
  const trimmed = lines.slice(-maxLines);
  return { text: trimmed.join('\n'), total: lines.length };
}

// Проверяет, что в шаблоне запроса есть обязательный маркер {{LOG}}.
function ensurePromptTemplate(template) {
  if (!template.includes('{{LOG}}')) {
    throw new Error('prompt_template must include {{LOG}} placeholder.');
  }
}

// Простая подстановка значений по ключам {{KEY}} в шаблоне текста.
function renderTemplate(template, values) {
  return Object.entries(values).reduce((acc, [key, val]) => acc.split(`{{${key}}}`).join(val), template);
}

// Определяет контекст текущего запуска: репозиторий, ID run и имя workflow
// из переменных окружения GitHub Actions.
function resolveRunContext() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runName = process.env.GITHUB_WORKFLOW || 'current workflow';

  if (!repository || !runId) {
    throw new Error('Repository or run id is missing; ensure this action runs inside a GitHub Actions workflow.');
  }

  const [owner, repo] = repository.split('/');
  return { owner, repo, runId, runName };
}

// Пытается вычислить номер PR: сперва из payload, затем из workflow_run.pull_requests,
// потом из ссылки вида refs/pull/123/....
function resolvePullRequestNumber(payload) {
  if (payload?.pull_request?.number) {
    return payload.pull_request.number;
  }
  if (payload?.workflow_run?.pull_requests?.[0]?.number) {
    return payload.workflow_run.pull_requests[0].number;
  }
  const ref = process.env.GITHUB_REF || process.env.GITHUB_REF_NAME || '';
  const match = ref.match(/refs\/pull\/(\d+)\//);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  return null;
}

// Ищет в PR существующий комментарий нашего бота по маркеру,
// чтобы обновлять, а не плодить новые.
async function findExistingComment(owner, repo, issueNumber, token) {
  let page = 1;
  while (true) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
    const comments = await githubRequest(url, token);
    if (!Array.isArray(comments) || comments.length === 0) {
      break;
    }
    const match = comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(MARKER));
    if (match) {
      return match;
    }
    if (comments.length < 100) {
      break;
    }
    page += 1;
  }
  return null;
}

// Создаёт или обновляет PR-комментарий с переданным текстом.
async function createOrUpdateComment(owner, repo, issueNumber, token, body, existingId) {
  if (existingId) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/comments/${existingId}`;
    return githubRequest(url, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  return githubRequest(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

// Отправляет сформированный запрос в OpenRouter и возвращает текст ответа модели.
async function callOpenRouter(apiKey, model, prompt) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Title': process.env.GITHUB_REPOSITORY || 'ai-ci-helper',
  };

  const referer = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : null;
  if (referer) {
    headers['HTTP-Referer'] = referer;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  console.log(`OpenRouter responded with status: ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response missing message content.');
  }

  return String(content).trim();
}

// Главный поток: проверяем, что workflow завершился с ошибкой, ищем последний упавший job/step,
// тянем его логи, вызываем OpenRouter для анализа, пишем результат в лог и в PR-комментарий (если есть PR).
async function main() {
  const openrouterApiKey = getInput('openrouter_api_key', { required: true });
  const model = getInput('model', { required: true });
  const promptTemplate = getInput('prompt_template', { required: true });
  const maxLogLinesInput = getInput('max_log_lines', { defaultValue: '500' });
  const maxLogLines = Number.parseInt(maxLogLinesInput, 10);
  const githubToken = process.env.GITHUB_TOKEN;

  if (!Number.isFinite(maxLogLines) || maxLogLines <= 0) {
    throw new Error('max_log_lines must be a positive integer.');
  }

  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required to call GitHub API.');
  }

  ensurePromptTemplate(promptTemplate);

  const payload = readEventPayload();
  const context = resolveRunContext();

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const runInfo = await fetchRun(context.owner, context.repo, context.runId, githubToken);
  const runConclusion = String(runInfo?.conclusion || '').toLowerCase();
  if (runConclusion && !FAILURE_CONCLUSIONS.has(runConclusion)) {
    console.log(`Workflow conclusion is "${runConclusion}". Nothing to analyze.`);
    return;
  }

  console.log(`Starting CI failure analysis for workflow: ${context.runName} (#${context.runId})`);

  const jobs = await fetchJobs(context.owner, context.repo, context.runId, githubToken);
  if (!jobs.length) {
    throw new Error('No jobs found for this workflow run.');
  }

  const failedJob = pickFailedJob(jobs);
  if (!failedJob) {
    throw new Error('Failed to locate a failed job; aborting.');
  }

  const failedStep = pickFailedStep(failedJob);
  const stepName = failedStep ? failedStep.name : 'Unknown step';

  const logsText = await fetchJobLogs(context.owner, context.repo, failedJob.id, githubToken);

  const { text: trimmedLog, total: totalLogLines } = trimLog(logsText, maxLogLines);

  console.log(`Analyzing job "${failedJob.name}" (id: ${failedJob.id}), step "${stepName}".`);
  console.log(`Original log lines: ${totalLogLines}; included lines: ${Math.min(totalLogLines, maxLogLines)}`);

  const prompt = renderTemplate(promptTemplate, {
    LOG: trimmedLog || 'Log is empty.',
    WORKFLOW_NAME: context.runName || '',
    JOB_NAME: failedJob.name || '',
    STEP_NAME: stepName || '',
  });

  let analysis = '';
  try {
    analysis = await callOpenRouter(openrouterApiKey, model, prompt);
  } catch (error) {
    console.error('OpenRouter request failed:', error.message);
    analysis = `Не удалось получить ответ от OpenRouter: ${error.message}`;
  }

  const body = [
    MARKER,
    `CI Failure Analysis (workflow: ${context.runName}, job: ${failedJob.name}, step: ${stepName})`,
    analysis,
    'Generated automatically after workflow failure.',
  ].join('\n');

  console.log('AI analysis:');
  console.log(body);

  const prNumber = resolvePullRequestNumber(payload);
  if (!prNumber) {
    console.log('No pull request context detected; skipping PR comment.');
    return;
  }

  try {
    const existing = await findExistingComment(context.owner, context.repo, prNumber, githubToken);
    const result = await createOrUpdateComment(
      context.owner,
      context.repo,
      prNumber,
      githubToken,
      body,
      existing?.id,
    );
    const commentId = result?.id || existing?.id;
    console.log(`PR comment ${existing ? 'updated' : 'created'} with ID: ${commentId}`);
  } catch (error) {
    console.error('Failed to create/update PR comment:', error.message);
  }
}

main().catch((error) => {
  console.error('CI helper failed:', error.message);
  process.exitCode = 1;
});
