You are grading the result of a coding agent's work against a rubric. Judge the end state, not the process.

Task given to the agent:
<task>{{prompt}}</task>

Rubric:
<rubric>{{rubric}}</rubric>

Changes the agent made (git diff):
<diff>{{diff}}</diff>

The agent's final message:
<final>{{finalText}}</final>

Reply with only a JSON object: {"score": <number from 0.0 to 1.0>, "pass": <true or false>, "reason": "<one or two sentences>"}
