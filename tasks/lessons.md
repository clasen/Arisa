# Lessons Learned

## File Sending in Claude Code

**Date**: 2026-02-11

**Issue**: When user asks "pasame la imagen" or "mandame el archivo", I was responding with descriptions + fullpath. This spams the user with unnecessary text.

**Root cause**: Claude Code's file detector (`src/core/file-detector.ts`) automatically sends files when it detects a fullpath in the response. Adding extra text defeats the purpose.

**Fix**:
- When user asks for a file → respond **only** with the absolute path, nothing else
- No descriptions, no context, no "Listo —" prefix
- Let the file detector handle the rest

**Example**:
- ❌ "Listo — zoom del ojo derecho. `/srv/tinyclaw/.tinyclaw/attachments/879964957/img_1770770740726_3d4e_eye_zoom.jpg`"
- ✅ `/srv/tinyclaw/.tinyclaw/attachments/879964957/img_1770770740726_3d4e_eye_zoom.jpg`

**Rule**: If the entire response is a single fullpath and nothing else, the file gets sent without spam.
