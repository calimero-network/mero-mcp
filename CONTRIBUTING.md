# Contributing to Mero MCP Server

Thank you for considering contributing to Mero MCP Server! This document outlines the process for contributing to the project and offers guidelines to ensure a smooth collaboration.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Community](#community)

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md) that all contributors are expected to follow. Please read it before participating.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** to your local machine
   ```bash
   git clone https://github.com/your-username/mero-mcp.git
   cd mero-mcp
   ```
3. **Set up the development environment**
   ```bash
   npm install
   ```
4. **Create a new branch** for your contribution
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

1. **Make your changes** in your feature branch
2. **Run tests** to ensure your changes don't break existing functionality
   ```bash
   npm test
   ```
3. **Run linting** to ensure code quality
   ```bash
   npm run lint
   ```
4. **Format your code** to match project style
   ```bash
   npm run format
   ```
5. **Commit your changes** following [conventional commits](https://www.conventionalcommits.org/) style
   ```bash
   git commit -m "feat: add new feature"
   ```

## Pull Request Process

1. **Update documentation** if necessary to reflect your changes
2. **Ensure all tests pass** and code quality checks are successful
3. **Push your branch** to your fork on GitHub
   ```bash
   git push origin feature/your-feature-name
   ```
4. **Open a pull request** against the main repository's `main` branch
5. **Address review feedback** if requested by maintainers
6. **Your PR will be merged** once it's approved!

## Coding Standards

- **TypeScript**: Use TypeScript for all new code
- **Formatting**: Follow Prettier's default style 
- **Linting**: Adhere to the ESLint rules configured in the project
- **Naming**: Use clear and descriptive names for functions, variables, and classes
- **Documentation**: Add JSDoc comments for all public APIs

## Testing Guidelines

- **Write tests** for all new functionality
- **Maintain coverage** at a minimum of 80% for statements, functions, and lines
- **Test structure**:
  - Unit tests for individual functions and classes
  - Integration tests for API endpoints
  - End-to-end tests for full workflows

## Documentation

- **Keep README up-to-date** with new features or changes to setup
- **Document public APIs** with JSDoc comments
- **Update example code** when interfaces change
- **Add inline comments** for complex or non-obvious code

## Community

- **Issues**: For bug reports, feature requests, or questions
- **Discussions**: For general conversation about the project
- **Pull Requests**: For direct code contributions

Thank you for contributing to Mero MCP Server! 