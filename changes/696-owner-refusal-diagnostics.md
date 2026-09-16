---
section: Fixed
issue: 696
---
Machine job refusals now report bounded diagnostic identifiers in the server log, including refusals received before job authority is available. Request contents and free-form exception text are excluded; gateway regression coverage verifies diagnostic retention and redaction.
