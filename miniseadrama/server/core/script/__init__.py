"""Public surface of the script generation package."""

from .docx_writer import write_script_docx, write_setting_docx
from .generator import ScriptGenerator
from .llm import LLMClient, LLMConfig, LLMError

__all__ = [
    "LLMClient",
    "LLMConfig",
    "LLMError",
    "ScriptGenerator",
    "write_script_docx",
    "write_setting_docx",
]
