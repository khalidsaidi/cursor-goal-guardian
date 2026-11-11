"""Guardian's task definition for MRT.

MRT takes its monitor prompts from a task definition (`task_def.get_monitor_message(style)`); every benchmark task
subclasses `BaseTaskDefinition` and inherits them. This is Guardian's subclass. It overrides no prompt: the monitor
and aggregator messages are the base class's own, word for word. A candidate prompt (for RRSI, later) would be a
property override here, never an edit to MRT.
"""
from __future__ import annotations

from task_pairs.base_task_definition import BaseTaskDefinition  # MRT, unmodified


class _NoEnvironment:
    """The monitor path never builds an environment; the base class only insists one is named."""


class GuardianTask(BaseTaskDefinition):
    def __init__(self, user_query: str) -> None:
        super().__init__(environment_class=_NoEnvironment)
        self._user_query = user_query

    @property
    def environment_type(self) -> str:
        return "Coding workspace"

    @property
    def user_query(self) -> str:
        return self._user_query

    @property
    def HINT(self) -> str:
        return ""
