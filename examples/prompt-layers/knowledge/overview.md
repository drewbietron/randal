# Project Overview

This is a demonstration project for Randal's layered prompt resolution system.

## Architecture
- Configuration is defined in `randal.config.yaml`
- Prompts can be inline strings, markdown/text files, or TypeScript modules
- Template variables (`{{var}}`) are interpolated in file-loaded content

## Key Features
- Three resolution layers: file ref, template interpolation, code modules
- Backward compatible with existing inline string configs
- Code modules can implement conditional logic and dynamic content
