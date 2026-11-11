"""Stand-ins for the imports MRT's monitor never executes.

MRT's modules import, at the top, everything its benchmark needs: pydantic, anthropic, openai, yaml, rich, pandas,
httpx, docstring_parser, and dozens of mock environments (bank accounts, calendars, ...). The monitor path
(`PipelineUtils.run_monitor` and what it calls) uses none of them. Guardian's bundled Python has the standard
library only, so before MRT is imported this module puts empty stand-ins for those names in the import system.
MRT's own files stay unmodified, and what runs of the monitor is MRT's code.

`task_pairs.j2_prompts` is among them: upstream imports it but doesn't ship it in the repository.
"""
from __future__ import annotations

import importlib.abc
import importlib.machinery
import sys
import types
import typing

# Whole packages that are fabricated, with every submodule under them.
PREFIXES = (
    "environment_classes", "environments", "tools", "task_evaluation",
    "pydantic", "anthropic", "openai", "yaml", "rich", "httpx", "pandas", "matplotlib", "seaborn",
    "docstring_parser",
)
# Single modules inside packages that otherwise hold real MRT files.
MODULES = ("task_pairs.j2_prompts", "utils.task_utils")


class _Meta(type):
    """Class attributes that don't exist are more stand-ins, so `Model.anything` never fails at import."""

    def __getattr__(cls, name: str):
        if name.startswith("__"):
            raise AttributeError(name)
        return _make(name)

    def __getitem__(cls, item):
        return cls


class Standin(metaclass=_Meta):
    """Usable as a base class, a value, a call result. Never does anything."""

    def __init__(self, *args, **kwargs) -> None:
        for k, v in kwargs.items():
            object.__setattr__(self, k, v)

    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)
        return _make(name)

    def __call__(self, *args, **kwargs):
        return _passthrough(args, kwargs)


class StandinError(Exception):
    """Stand-in for an imported exception class, so `except SomeError:` clauses stay valid."""


def _passthrough(args, kwargs):
    # `@decorator` and `@decorator(...)` both leave the decorated thing as it was.
    if len(args) == 1 and not kwargs and (callable(args[0]) or isinstance(args[0], (classmethod, staticmethod))):
        return args[0]
    return _function


def _function(*args, **kwargs):
    return _passthrough(args, kwargs)


def _make(name: str):
    if name.endswith(("Error", "Exception")):
        return type(name, (StandinError,), {})
    if name[:1].isupper():
        return type(name, (Standin,), {})
    return _function


class _Module(types.ModuleType):
    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)
        value = _make(name)
        setattr(self, name, value)
        return value


class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in MODULES or fullname.split(".")[0] in PREFIXES:
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        module = _Module(spec.name)
        module.__path__ = []  # a package, so submodules resolve through this finder too
        return module

    def exec_module(self, module) -> None:
        return None


_installed = False


def install() -> None:
    """Idempotent. Stand-ins win over real packages, so behaviour is the same on every machine."""
    global _installed
    if _installed:
        return
    _installed = True
    sys.meta_path.insert(0, _Finder())
    # MRT uses typing_extensions for names the standard library has had since 3.11.
    sys.modules.setdefault("typing_extensions", typing)
