# A stand-in for OSWorld's desktop_env/evaluators/getters/__init__.py (https://github.com/xlang-ai/OSWorld, Apache-2.0,
# Copyright 2024 XLANG NLP Lab): the names the loader's fixtures use, in its import shape. The loader reads it as text.
from .chrome import (
    get_default_search_engine,
    get_cookie_data,
)
from .file import get_cloud_file, get_vm_file
from .general import get_vm_command_line
from .misc import get_rule, get_accessibility_tree
