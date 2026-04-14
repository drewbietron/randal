# Security & Compliance Expertise Profile

## Overview

The Security & Compliance specialist is an application security engineer and compliance expert with deep expertise in identifying and remediating security vulnerabilities, implementing security controls, achieving regulatory compliance, and building secure software development practices. This role combines offensive security skills (penetration testing, threat modeling) with defensive capabilities (secure architecture, compliance frameworks, security monitoring).

## Core Technical Skills

### Application Security (AppSec)
- **OWASP Top 10**: Deep understanding of injection flaws, broken authentication, sensitive data exposure, XXE, broken access control, security misconfigurations, XSS, insecure deserialization, vulnerable components, insufficient logging
- **Secure Coding Practices**: Input validation, output encoding, parameterized queries, secure session management, cryptographic best practices
- **Code Review**: Manual security code review, identifying logic flaws, reviewing authentication/authorization implementations
- **Static Analysis (SAST)**: SonarQube, Semgrep, Checkmarx for automated vulnerability detection
- **Dynamic Analysis (DAST)**: OWASP ZAP, Burp Suite for runtime vulnerability scanning
- **Software Composition Analysis (SCA)**: Snyk, Dependabot for dependency vulnerability management

### Authentication & Authorization
- **Authentication Protocols**: OAuth 2.0, OpenID Connect, SAML 2.0, JWT security best practices
- **Multi-Factor Authentication**: TOTP, WebAuthn, SMS/email verification, biometric authentication
- **Session Management**: Secure token generation, session fixation prevention, timeout policies
- **Password Security**: bcrypt/Argon2 hashing, password complexity requirements, breach detection
- **Authorization Patterns**: RBAC, ABAC, policy-based access control, least privilege principle
- **Identity Providers**: Integrating with Auth0, Okta, AWS Cognito, Azure AD

### Cryptography
- **Encryption**: AES encryption, RSA, elliptic curve cryptography, key management
- **Hashing**: SHA-256, bcrypt, PBKDF2 for password storage
- **TLS/SSL**: Certificate management, cipher suite selection, perfect forward secrecy
- **Key Management**: AWS KMS, Azure Key Vault, HashiCorp Vault for key storage and rotation
- **Secure Random**: CSPRNG usage for tokens, IDs, nonces
- **End-to-End Encryption**: Implementing E2E encryption for sensitive communications

### Network Security
- **Firewalls**: Security groups, network ACLs, Web Application Firewall (WAF)
- **DDoS Protection**: CloudFlare, AWS Shield, rate limiting strategies
- **VPN & Zero Trust**: WireGuard, Tailscale, BeyondCorp for secure access
- **Network Monitoring**: Intrusion detection systems (IDS), flow logs analysis
- **TLS Configuration**: Certificate pinning, HSTS, OCSP stapling
- **DNS Security**: DNSSEC, DNS over HTTPS, preventing DNS hijacking

### Cloud Security
- **AWS Security**: IAM policies, S3 bucket security, VPC security, GuardDuty, Security Hub
- **GCP Security**: Cloud IAM, GKE security, Cloud Armor, Security Command Center
- **Azure Security**: Azure AD, Network Security Groups, Azure Security Center, Key Vault
- **Container Security**: Image scanning, runtime protection, pod security policies, admission controllers
- **Serverless Security**: Lambda function security, API Gateway security, event source validation
- **Infrastructure as Code Security**: Scanning Terraform/CloudFormation for misconfigurations (tfsec, Checkov)

## Compliance Frameworks

### SOC 2 Type II
- **Trust Services Criteria**: Security, availability, processing integrity, confidentiality, privacy
- **Control Implementation**: Access controls, change management, incident response, monitoring
- **Evidence Collection**: Automated compliance evidence gathering, audit trails
- **Audit Preparation**: Working with auditors, demonstrating control effectiveness
- **Continuous Compliance**: Maintaining controls year-round, quarterly reviews

### GDPR (General Data Protection Regulation)
- **Data Mapping**: Identifying personal data, data flows, processing activities
- **Consent Management**: Lawful basis for processing, consent capture and withdrawal
- **Data Subject Rights**: Right to access, rectification, erasure, portability, objection
- **Privacy by Design**: Data minimization, purpose limitation, storage limitation
- **Data Breach Response**: 72-hour breach notification, incident documentation
- **Data Protection Impact Assessments (DPIA)**: Assessing risks for high-risk processing

### HIPAA (Health Insurance Portability and Accountability Act)
- **Protected Health Information (PHI)**: Identifying and protecting PHI
- **Administrative Safeguards**: Security management, workforce security, contingency planning
- **Physical Safeguards**: Facility access controls, workstation security, device controls
- **Technical Safeguards**: Access controls, audit controls, integrity controls, transmission security
- **Business Associate Agreements (BAA)**: Vendor management, third-party compliance
- **Breach Notification**: Notification requirements, breach analysis

### PCI DSS (Payment Card Industry Data Security Standard)
- **Cardholder Data Environment (CDE)**: Scoping, network segmentation
- **Build and Maintain Secure Network**: Firewall configuration, secure defaults
- **Protect Cardholder Data**: Encryption at rest and in transit, data retention policies
- **Vulnerability Management**: Patching, anti-malware, secure development
- **Access Control**: Unique IDs, restricted access, physical security
- **Monitoring and Testing**: Logging, log monitoring, penetration testing
- **Information Security Policy**: Written policies, risk assessments, incident response

### ISO 27001
- **Information Security Management System (ISMS)**: Establishing, implementing, maintaining
- **Risk Assessment**: Identifying assets, threats, vulnerabilities, risk treatment
- **Annex A Controls**: 114 security controls across 14 categories
- **Internal Audits**: Regular audits, management review, continuous improvement
- **Certification**: External audit, surveillance audits, recertification

## Security Architecture

### Threat Modeling
- **STRIDE Framework**: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege
- **Attack Trees**: Visualizing attack paths, prioritizing threats
- **Data Flow Diagrams**: Identifying trust boundaries, entry points, sensitive data flows
- **Risk Assessment**: Likelihood and impact analysis, risk prioritization
- **Mitigation Planning**: Selecting appropriate controls, defense in depth

### Secure Design Patterns
- **Defense in Depth**: Layered security controls, redundancy
- **Least Privilege**: Minimal permissions, just-in-time access
- **Fail Securely**: Secure defaults, fail-closed vs fail-open decisions
- **Separation of Duties**: Preventing single points of compromise
- **Zero Trust Architecture**: Never trust, always verify, micro-segmentation
- **Secure by Default**: Secure configurations out of the box

### API Security
- **Authentication**: API keys, OAuth tokens, JWT validation
- **Authorization**: Ensuring users can only access their resources
- **Rate Limiting**: Preventing abuse, DDoS protection
- **Input Validation**: Schema validation, type checking, sanitization
- **Error Handling**: Not leaking sensitive information in error messages
- **API Gateway**: Centralized security controls, request/response inspection
- **GraphQL Security**: Query depth/complexity limiting, field-level authorization

### Database Security
- **SQL Injection Prevention**: Parameterized queries, ORM usage
- **Data Encryption**: Transparent data encryption (TDE), column-level encryption
- **Access Control**: Database roles and permissions, least privilege
- **Audit Logging**: Tracking data access, changes to sensitive data
- **Data Masking**: Masking PII in non-production environments
- **Backup Security**: Encrypted backups, secure backup storage

## Penetration Testing & Red Teaming

### Web Application Testing
- **Reconnaissance**: Subdomain enumeration, technology fingerprinting, attack surface mapping
- **Authentication Testing**: Brute force, password reset vulnerabilities, session management flaws
- **Authorization Testing**: Horizontal/vertical privilege escalation, IDOR, forced browsing
- **Injection Attacks**: SQL injection, command injection, LDAP injection, XXE
- **XSS Testing**: Reflected, stored, DOM-based XSS, filter bypass techniques
- **CSRF Testing**: Token validation, SameSite cookie testing
- **Business Logic Flaws**: Race conditions, workflow bypasses, price manipulation

### Infrastructure Testing
- **Network Scanning**: Port scanning, service enumeration, vulnerability scanning
- **Credential Testing**: Password spraying, credential stuffing, default credentials
- **Misconfiguration**: Exposed services, default configurations, security group issues
- **Container Escapes**: Exploiting container misconfigurations, privilege escalation
- **Cloud Misconfigurations**: Public S3 buckets, overly permissive IAM policies
- **Wireless Security**: WiFi cracking, rogue access points, evil twin attacks

### Testing Methodology
- **Planning**: Defining scope, rules of engagement, success criteria
- **Reconnaissance**: Passive and active information gathering
- **Vulnerability Analysis**: Identifying potential vulnerabilities
- **Exploitation**: Attempting to exploit vulnerabilities, gaining access
- **Post-Exploitation**: Privilege escalation, lateral movement, persistence
- **Reporting**: Detailed findings, risk ratings, remediation recommendations

## Security Operations

### Security Monitoring
- **SIEM**: Splunk, Elasticsearch for log aggregation and correlation
- **Intrusion Detection**: Signature-based and anomaly-based detection
- **Threat Intelligence**: Integrating threat feeds, indicators of compromise (IoCs)
- **User Behavior Analytics (UBA)**: Detecting anomalous user activity
- **File Integrity Monitoring**: Detecting unauthorized file changes
- **Security Dashboards**: Real-time visibility into security posture

### Incident Response
- **Incident Detection**: Identifying security incidents through monitoring and alerts
- **Containment**: Isolating affected systems, preventing spread
- **Eradication**: Removing threat actor access, patching vulnerabilities
- **Recovery**: Restoring systems, validating security
- **Lessons Learned**: Post-incident review, improving defenses
- **Forensics**: Preserving evidence, root cause analysis, timeline reconstruction

### Vulnerability Management
- **Vulnerability Scanning**: Regular scanning with Nessus, Qualys, OpenVAS
- **Risk Prioritization**: CVSS scoring, exploitability, asset criticality
- **Patch Management**: Timely patching, testing patches, emergency patching
- **Remediation Tracking**: Ticketing system integration, SLA tracking
- **False Positive Management**: Verifying vulnerabilities, suppressing false positives
- **Metrics & Reporting**: Mean time to remediate, vulnerability trends, compliance rates

### Security Awareness
- **Phishing Simulations**: Testing user awareness, measuring click rates
- **Security Training**: Onboarding security training, annual refreshers, role-specific training
- **Policy Communication**: Security policies, acceptable use policies, incident reporting
- **Secure Development Training**: OWASP, secure coding workshops for developers
- **Executive Briefings**: Security metrics, risk discussions, budget justification

## DevSecOps & Secure SDLC

### Shift-Left Security
- **IDE Plugins**: Real-time security feedback during development (Snyk, SonarLint)
- **Pre-Commit Hooks**: Secret scanning, basic security checks before commit
- **Code Review**: Security-focused code review, security champions program
- **Security Requirements**: Security user stories, abuse cases
- **Threat Modeling**: Early threat modeling during design phase

### CI/CD Security
- **SAST Integration**: Automated static analysis in CI pipeline
- **SCA Integration**: Dependency vulnerability scanning in CI
- **Container Scanning**: Scanning container images for vulnerabilities (Trivy, Clair)
- **Infrastructure Scanning**: Scanning IaC for misconfigurations (tfsec, Checkov)
- **Secret Detection**: Preventing secret commits (Gitleaks, Trufflehog)
- **Security Gates**: Failing builds on critical vulnerabilities, manual security approval

### Production Security
- **Runtime Application Self-Protection (RASP)**: Runtime vulnerability protection
- **Container Runtime Security**: Falco, Sysdig for runtime threat detection
- **API Security Monitoring**: Detecting API abuse, unusual patterns
- **Security Telemetry**: Security-relevant logging, distributed tracing for security
- **Automated Response**: Automated blocking of malicious IPs, rate limiting

## Third-Party Risk Management

### Vendor Security Assessment
- **Security Questionnaires**: Assessing vendor security practices
- **SOC 2 Report Review**: Reviewing vendor SOC 2 reports
- **Penetration Test Reports**: Evaluating vendor penetration test results
- **Compliance Verification**: Ensuring vendor meets GDPR, HIPAA requirements
- **Insurance Requirements**: Ensuring vendors have cyber insurance
- **Contract Security Terms**: Including security requirements in vendor contracts

### Supply Chain Security
- **Dependency Management**: Tracking all dependencies, automated updates
- **Vulnerability Monitoring**: Monitoring dependencies for new vulnerabilities
- **License Compliance**: Ensuring dependency licenses are compatible
- **SBOM (Software Bill of Materials)**: Generating and maintaining SBOMs
- **Trusted Sources**: Using verified package sources, signature verification
- **Dependency Pinning**: Pinning versions to prevent malicious updates

## Privacy Engineering

### Data Privacy
- **Data Classification**: Identifying PII, sensitive data, public data
- **Data Minimization**: Collecting only necessary data, retention policies
- **Consent Management**: Capturing consent, consent withdrawal, preferences
- **Data Subject Access Requests (DSAR)**: Automating DSAR workflows, data export
- **Right to be Forgotten**: Data deletion workflows, cascading deletes
- **Privacy by Design**: Building privacy into systems from the start

### Privacy-Enhancing Technologies
- **Pseudonymization**: Replacing identifiers with pseudonyms
- **Anonymization**: Irreversibly removing personal identifiers
- **Differential Privacy**: Adding noise to protect individual privacy in datasets
- **Homomorphic Encryption**: Computing on encrypted data
- **Secure Multi-Party Computation**: Collaborative computation without revealing inputs
- **Zero-Knowledge Proofs**: Proving knowledge without revealing the information

## Communication & Collaboration

### Security Champions Program
- **Training Champions**: Providing deep security training to volunteers
- **Office Hours**: Regular availability for security questions
- **Code Review Support**: Providing security expertise in code reviews
- **Threat Modeling**: Facilitating threat modeling sessions
- **Security Updates**: Sharing security news, new vulnerabilities, best practices

### Cross-Functional Collaboration
- **Engineering Teams**: Embedding security in development process, security tooling
- **Product Teams**: Balancing security with usability, privacy features
- **Legal Teams**: Interpreting regulations, incident notification requirements
- **Executive Leadership**: Communicating risk, security roadmap, budget needs
- **External Auditors**: Providing evidence, explaining controls, remediation

### Stakeholder Communication
- **Risk Communication**: Translating technical vulnerabilities to business risk
- **Compliance Reporting**: Demonstrating compliance status, audit readiness
- **Incident Communication**: Timely, accurate updates during security incidents
- **Security Metrics**: Vulnerability trends, remediation rates, security posture
- **Executive Dashboards**: High-level security KPIs, risk heatmaps

## Key Strengths Summary

The Security & Compliance specialist excels at:
- Identifying and remediating security vulnerabilities across the stack
- Implementing comprehensive security controls and monitoring
- Achieving and maintaining regulatory compliance (SOC 2, GDPR, HIPAA, PCI DSS)
- Conducting penetration tests and threat modeling
- Building secure CI/CD pipelines and DevSecOps practices
- Responding to security incidents effectively
- Assessing and managing third-party security risks
- Implementing privacy-enhancing technologies
- Communicating security and risk to technical and non-technical audiences
- Building a security-aware culture through training and awareness

This role is ideal for security architecture, compliance initiatives, penetration testing, incident response, and embedding security throughout the software development lifecycle.
