# Persona Proxy — Opt-In

**Extension**: Persona Proxy (Absent-Role Advisory)

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Persona Proxy (Absent-Role Advisory)
Is any professional role absent or under-represented in your team (mob)? For each role you select, an AI persona will add an advisory recommendation block (suggested answer + rationale + confidence) to questions in that role's domain throughout the workflow. The final answer to every question always remains yours — personas never fill in answers.

Select ALL that apply (e.g., "C, F"):

A) Product Owner — represents business and users: business goals, success criteria, user scenarios, user journeys, story acceptance criteria

B) Software Architect — owns system-level structure: component boundaries, system decomposition, design patterns, risk and change-impact assessment

C) Backend Engineer — owns server-side implementation: domain models, business rules, data flow, error handling, API and repository layers

D) Frontend Engineer — owns client-side implementation: UI component structure, state management, form handling, backend API integration (implementation judgment only; user-journey questions belong to Product Owner)

E) DevOps Engineer — owns infrastructure and delivery: cloud service selection, compute/storage/networking, CI/CD, deployment strategy, monitoring and observability

F) Security Engineer — owns security posture: encryption, authentication/authorization, least privilege, input validation, compliance and threat modeling

G) QA Engineer — owns quality strategy: test strategy across unit/integration/E2E/performance/contract tests, testability of acceptance criteria, edge-case coverage

H) None — all roles are sufficiently represented; do not activate any persona

X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
