# Project constitution for Parcel

This document constitutes the ultimate governing document for the Parcel
project.  It outlines the fundamental principles, values, and guidelines that
govern the development, maintenance, and community engagement of the project,
and in the event of any conflict with other documents, this constitution shall
take precedence.

## 1. Core principles

### 1.1 Clear purpose and scope

Parcel is designed to be a tool for securely searching, viewing, and
automatically entering into the user's browser credentials that are stored in
GPG-encrypted text files on the user's local filesystem.  It is not intended to
provide all possible features that a password manager could in theory provide,
and it is not intended to be anything other than a password manager.

For clarity, Parcel is intended to complement ZX2C4's
[pass](https://www.passwordstore.org/) tool, but is not a replacement for it.
As such, some features (e.g. creating, editing, and synchronising files with
other locations) are explicitly outside the scope of what Parcel will
implement. The user is expected to take responsibility for managing their own
credential files as they see fit.

### 1.2 Open source commitment

Parcel is committed to being an open-source project, fostering transparency,
collaboration, and community involvement. All source code, documentation, and
related materials shall be freely available under the ISC License.

#### 1.2.1 Release Packaging

In addition to the availability and visibility of development source code (e.g.
via GitHub), the *distributed* form of the project must also retain full source
visibility. This means that any packaging tools or processes which obfuscate or
hide source code (e.g. Webpack) *may not be used*, and the native host must be
a plaintext script file, not a compiled binary. Distribution of ready-to-use
extension files (e.g. CRX or zip files) is permitted - for this manner of
distribution, the restrictions mentioned above refer to the *contents* of such
files.

### 1.3 Minimising attack surfaces

All architectural and design decisions must be made taking into account the
security implications of such decisions, and what attack surfaces they may
create. The project must be designed and implemented in a way that minimises
the potential for security vulnerabilities and exploits, and that prioritises
the safety and security of users.

#### 1.3.1 No third-party dependencies

Supply-chain attacks are a significant and growing threat to software projects,
and the use of third-party dependencies can introduce significant risks without
them necessarily being evident to the project maintainers or end-users, and
without them being easily picked up by any security audit of the project. For
this reason:

 - The browser extension must not rely on any third-party executable
   dependencies. The entirety of the extension logic must be implemented using
   native browser APIs, and must be written using native JavaScript, HTML and CSS.
   Transpiling tools such as TypeScript, Less, etc. are also prohibited, in order
   to avoid the resulting exposure to build-time external dependencies. For
   clarity, this means that the project's maintained source code must match what
   is ultimately distributed to users.

 - The native host environment (i.e. the bash shell) necessarily involves the
   use of various system executables (e.g. `jq`), however the exposure to these
   executables must be minimised as much as possible, and limited to only those
   tools which may reasonably be expected to be present out-of-the-box on a
   typical Linux or macOS system.

#### 1.3.2 No compiled native host

Parcel's native host component must be implemented as a plaintext script file,
and may not be compiled into a binary executable. This is to ensure that the
source code of the native host is always visible and auditable by users.

#### 1.3.3 No file modification

Parcel is explicitly designed as a read-only tool, and must not modify any
files on the user's filesystem.

The only exceptions to this rule are:

 - The native host may create a default `parcelrc` startup configuration file
   if one does not already exist; and

 - The native host may create and append to a dedicated log file (e.g.
   `parcel.log`) for the purposes of logging errors and other relevant
   information. This log file must never, under any circumstances, contain any
   part of the user's decrypted credential files.

 - The native host bootstrap script may create a temporary gpg keyring for the
   purpose of verifying the signature of the bundled native host, in order to
   avoid polluting the user's existing gpg keyring with the release signing keys.

For clarity, this also means that Parcel is prohibited from modifying its own
configuration.

#### 1.3.4 No arbitrary file access

Other than its own configuration and logs, Parcel must not have access to any
files on the user's filesystem that the user has not explicitly whitelisted.
This restriction must be enforced by the native host script, such that the
browser extension is *incapable* of accessing any non-whitelisted files, even
in the event of a full compromise.

#### 1.3.5 No network access

Parcel must not interact with any network resources, for any reason. For the
avoidance of doubt, this includes any form of telemetry or analytics, and any
form of error reporting or crash reporting that involves sending data to a
remote server. Parcel's complete functionality must be entirely self-contained
within the user's local environment, and must not rely on any external services
or resources.

## 2 Release management

### 2.1 Release authorship and distribution

All official release packaging and distribution must be handled by the
following people only:

 - Steve Gilberd
 - Max Baz

No person not named in this section of the constitution may package or
distribute releases of Parcel, and any such releases that are not packaged by
the above parties must be considered unofficial and potentially unsafe to use.
The source code of the project may of course be freely forked and modified by
anyone, and anybody who forks it is free to distribute their fork as they see
fit, but only releases packaged by the above parties may be considered official
releases of the project.

### 2.2 Release signing and verification

All official releases of Parcel must be signed using GPG, and the signatures
must be made available alongside the release files.

Only the following GPG keys may be used to sign official releases of Parcel:

 - Steve Gilberd: 88FF14D6294AF4036B7F00FF676A3C09E2E47A72
 - Max Baz: 56C3E775E72B0C8B1C0C1BD0B5DB77409B11B601
 - Parcel release signing key #1: 82ED663067C6017BAA4BC752EB670BF2B1131683
 - Parcel release signing key #2: B0908ED59A96C9882BED9A942A51761511A30253

The latter two keys are present for backup purposes only, and will not be used
to sign releases unless one of the primary keys is unavailable for an extended
period.

Private keys used to sign releases must be kept secure, and must only be used
on a dedicated hardware device (e.g. a YubiKey), or on an air-gapped machine
that is not used for any other purpose. The private keys must never be stored
on any network-connected device, and must never be exposed to the internet in
any way.

## 3 Code authorship

All code contributions must be fully tested by the submitter, and must be
reviewed and approved by at least one of the project maintainers before being
merged into the main codebase. Final review and approval prior to merge must be
performed by a human, not delegated (either in whole or in part) to an
automated system.

The submitter must have full authority to make the contribution under the ISC
licence, and must ensure that the contribution does not infringe on any
third-party intellectual property rights.

All commits must be signed with a GPG key that is valid at the time the
contribution is merged.

Contributors to the project must also adhere to any additional guidelines or
requirements that may be outlined in [CONTRIBUTING.md][1].

## 4 Community standards

Contributors and other members of the community engaging with the project are
expected to interact in a reasonable manner, and to treat each other with
respect and professionalism. Robust disagreement is fine, but personal attacks,
harassment, and other forms of toxic behaviour will not be tolerated.

## 5 Governance

The Parcel project is governed by a core team of maintainers in accordance with
this constitution. These maintainers are responsible for overseeing the
development, maintenance, and integrity of the project, and for making
decisions about its direction and priorities.

This core team is composed of the following individuals:

 - Steve Gilberd
 - Max Baz

### 5.1 Constitutional amendments

This constitution may be amended by a unanimous vote of all available members
of the core team, via a formal pull request on the project's GitHub repository.
Any proposed amendments must be clearly documented and justified in the pull
request. Only those people named in the "Governance" section of this
constitution may vote on proposed amendments.

In the event that the core team is unable to reach a unanimous decision on a
proposed amendment, the amendment will be rejected and the existing
constitution will remain in effect.

In the event that a core team member is unable to respond to a proposed
amendment within a reasonable timeframe (e.g. due to illness, travel, etc.),
the remaining core team members may proceed with the amendment process and make
a decision based on the votes of the available members. However, if the absent
member later returns and disagrees with the decision made in their absence,
they may raise their concerns and request a re-evaluation of the amendment,
which will then be subject to a new vote by the core team.

Any proposed amendment must be available for voting for a minimum of 7 days to
allow all core team members sufficient time to review and consider the proposal
before voting. If a core team member does not cast their vote within this 7-day
period, and has not otherwise indicated that they are aware of the proposal and
intend to vote, other members of the core team must make every reasonable
effort to contact the non-voting member to ensure they are aware of the
proposal and have the opportunity to vote before the voting period ends. If
such a core team member fails to vote within a further 7-day period following
that additional contact attempt, their vote will be considered abstained for
that amendment.

Approving or rejecting an amendment pull request via GitHub's review feature is
deemed to constitute the casting of a vote.

[1]: CONTRIBUTING.md
