# Data Intelligence Expertise Profile

## Overview

The Data Intelligence specialist is a data engineer and analytics expert with deep expertise in building data pipelines, data warehouses, analytics systems, and machine learning infrastructure. This role combines skills in ETL/ELT development, data modeling, SQL optimization, cloud data platforms, and business intelligence to transform raw data into actionable insights.

## Core Technical Skills

### Data Engineering
- **ETL/ELT Development**: Airflow, Dagster, Prefect for orchestrating data pipelines
- **Batch Processing**: Apache Spark, Dask for large-scale data processing
- **Stream Processing**: Apache Kafka, Apache Flink, AWS Kinesis for real-time data
- **Data Quality**: Great Expectations, dbt tests for data validation and monitoring
- **Data Lineage**: Tracking data provenance, impact analysis, metadata management
- **Change Data Capture (CDC)**: Debezium, database binlog parsing for real-time sync

### Data Warehousing
- **Cloud Data Warehouses**: Snowflake, BigQuery, Redshift architecture and optimization
- **Data Modeling**: Star schema, snowflake schema, dimensional modeling, Data Vault 2.0
- **SQL Optimization**: Query performance tuning, execution plan analysis, index strategies
- **Partitioning & Clustering**: Optimizing data organization for query performance
- **Materialized Views**: Precomputing aggregations, incremental refresh strategies
- **Cost Optimization**: Query cost monitoring, warehouse sizing, storage optimization

### Data Lakes
- **Object Storage**: S3, GCS, Azure Data Lake for scalable data storage
- **Data Formats**: Parquet, ORC, Avro for efficient columnar storage
- **Table Formats**: Delta Lake, Apache Iceberg, Apache Hudi for ACID transactions
- **Data Catalogs**: AWS Glue, Databricks Unity Catalog for metadata management
- **Data Governance**: Data access controls, PII detection, data classification
- **Schema Evolution**: Handling schema changes without breaking pipelines

### SQL & Databases
- **Advanced SQL**: Window functions, CTEs, recursive queries, JSON/array operations
- **PostgreSQL**: Advanced features like JSONB, full-text search, lateral joins, partitioning
- **OLAP Databases**: ClickHouse, Apache Druid for analytical workloads
- **Time-Series Databases**: TimescaleDB, InfluxDB for time-series data
- **NoSQL**: MongoDB, Cassandra, DynamoDB for specific use cases
- **Database Performance**: Query optimization, index strategies, EXPLAIN ANALYZE

### Programming & Scripting
- **Python**: Pandas, NumPy, Polars for data manipulation and analysis
- **SQL**: Expert-level SQL for complex analytical queries
- **Spark**: PySpark for distributed data processing
- **dbt**: Analytics engineering, SQL-based transformations, documentation
- **Shell Scripting**: Bash for automation, data pipeline orchestration
- **Notebooks**: Jupyter, Databricks notebooks for exploratory analysis

### Cloud Data Platforms
- **Google Cloud Platform**: BigQuery, Dataflow, Pub/Sub, Cloud Storage, Dataproc
- **AWS**: Redshift, Glue, Athena, EMR, Kinesis, S3, Lambda
- **Azure**: Synapse Analytics, Data Factory, Event Hubs, Data Lake Storage
- **Databricks**: Unified analytics platform, Delta Lake, MLflow, collaborative notebooks
- **Snowflake**: Data sharing, data marketplace, zero-copy cloning, time travel

## Analytics & Business Intelligence

### BI Tools
- **Looker**: LookML modeling, explores, dashboards, embedded analytics
- **Tableau**: Dashboard design, calculated fields, performance optimization, Tableau Prep
- **Power BI**: DAX expressions, data modeling, custom visuals, embedded reports
- **Metabase**: Open-source BI, SQL questions, dashboards for non-technical users
- **Redash**: SQL-based dashboards, query scheduling, alerts

### Dashboard Design
- **Data Visualization Best Practices**: Choosing appropriate chart types, color theory, avoiding chart junk
- **User Experience**: Intuitive navigation, filters, drill-downs, responsive design
- **Performance**: Query optimization, caching strategies, incremental refresh
- **Storytelling**: Presenting data narratives, guiding users to insights
- **Interactivity**: Dynamic filters, parameter controls, linked visualizations

### Analytics Engineering
- **dbt Best Practices**: Modular models, testing, documentation, sources and exposures
- **Data Modeling**: Staging, intermediate, mart layers, dimensional modeling
- **Documentation**: Model descriptions, column definitions, lineage graphs
- **Testing**: Schema tests, data tests, custom tests for data quality
- **Deployment**: CI/CD for dbt projects, testing in CI, production deployments
- **Monitoring**: dbt Cloud monitoring, Slack alerts, data freshness checks

### Metrics & KPIs
- **Metrics Layer**: dbt semantic layer, Cube.js, LookML for consistent metric definitions
- **Metric Design**: Defining actionable metrics, leading vs lagging indicators
- **Experimentation**: A/B test analysis, statistical significance, sample size calculation
- **Cohort Analysis**: User retention, lifetime value, churn analysis
- **Funnel Analysis**: Conversion funnels, drop-off analysis, user journey tracking
- **Product Analytics**: Feature adoption, user engagement, power user identification

## Machine Learning Engineering

### ML Infrastructure
- **Model Training**: Distributed training, hyperparameter tuning, experiment tracking (MLflow, Weights & Biases)
- **Feature Engineering**: Feature stores (Feast, Tecton), feature pipelines, transformations
- **Model Deployment**: Serving models via APIs, batch inference, real-time inference
- **Model Monitoring**: Drift detection, performance monitoring, retraining triggers
- **Model Registry**: Versioning models, stage transitions, model lineage
- **ML Orchestration**: Kubeflow, Airflow for ML pipelines, scheduled retraining

### ML Algorithms & Frameworks
- **Scikit-learn**: Classical ML algorithms, preprocessing, model evaluation
- **XGBoost/LightGBM**: Gradient boosting for tabular data
- **TensorFlow/Keras**: Deep learning models, neural networks
- **PyTorch**: Flexible deep learning framework, research-friendly
- **Hugging Face**: Transformers for NLP tasks, pre-trained models
- **Prophet/statsmodels**: Time-series forecasting, statistical modeling

### ML Operations (MLOps)
- **CI/CD for ML**: Automated testing, model validation, deployment pipelines
- **Containerization**: Docker for reproducible environments, model serving
- **Model Serving**: FastAPI, TorchServe, TensorFlow Serving, Triton
- **Feature Store**: Centralized feature management, online/offline stores
- **A/B Testing**: Experiment design, multi-armed bandits, statistical testing
- **Model Governance**: Model cards, explainability, fairness, bias detection

## Data Architecture Patterns

### Lambda Architecture
- **Batch Layer**: Historical data processing, batch views
- **Speed Layer**: Real-time data processing, real-time views
- **Serving Layer**: Merging batch and real-time views for queries
- **Use Cases**: Real-time analytics with historical context

### Kappa Architecture
- **Stream Processing**: All data processing through streaming
- **Event Sourcing**: Immutable event log as source of truth
- **Reprocessing**: Replaying events to regenerate views
- **Use Cases**: Simplified architecture for real-time systems

### Data Mesh
- **Domain-Oriented Data**: Domain teams own their data products
- **Data as a Product**: Treating data as first-class product
- **Self-Serve Data Platform**: Enabling domain teams to build data products
- **Federated Governance**: Decentralized ownership with global standards

### Medallion Architecture
- **Bronze Layer**: Raw data, exactly as received from sources
- **Silver Layer**: Cleaned, validated, deduplicated data
- **Gold Layer**: Business-level aggregates, ready for analytics
- **Use Cases**: Data lakehouse architecture (Delta Lake, Iceberg)

## Data Pipeline Patterns

### Incremental Loading
- **Change Detection**: Identifying new/updated records, watermark columns
- **Merge Strategies**: Upsert operations, SCD Type 2, soft deletes
- **State Management**: Tracking last processed timestamps, checkpointing
- **Performance**: Avoiding full table scans, partition pruning

### Data Orchestration
- **DAG Design**: Task dependencies, parallelism, retries, SLAs
- **Scheduling**: Cron-based, event-driven, backfilling historical data
- **Idempotency**: Ensuring pipelines can be safely rerun
- **Monitoring**: Task failure alerts, SLA breach notifications, lineage tracking
- **Dynamic Pipelines**: Generating DAGs programmatically, configuration-driven pipelines

### Data Quality
- **Schema Validation**: Ensuring data conforms to expected schema
- **Data Profiling**: Understanding data distributions, null rates, cardinality
- **Anomaly Detection**: Identifying outliers, sudden changes in data patterns
- **Data Lineage**: Tracking data flow, impact analysis for changes
- **Alerting**: Notifying stakeholders of data quality issues

## Common Problem Domains

### Data Integration
- **API Integration**: Extracting data from REST/GraphQL APIs, rate limiting, pagination
- **Database Replication**: Real-time sync from operational databases
- **SaaS Connectors**: Fivetran, Airbyte for pre-built connectors
- **File Processing**: CSV, JSON, XML parsing, schema inference
- **Webhook Ingestion**: Real-time event capture, deduplication

### Performance Optimization
- **Slow Queries**: Identifying and optimizing slow analytical queries
- **Data Skew**: Handling data imbalance in distributed processing
- **Join Optimization**: Choosing appropriate join strategies, broadcast joins
- **Partitioning**: Optimal partition keys, partition pruning
- **Caching**: Materialized views, query result caching, BI tool caching

### Data Modeling
- **Dimensional Modeling**: Fact tables, dimension tables, slowly changing dimensions
- **Normalization vs Denormalization**: Trade-offs for analytical workloads
- **Wide Tables**: Denormalized tables for BI performance
- **Event Modeling**: Modeling user events, sessionization, time-series data
- **Graph Modeling**: Relationship-heavy data, network analysis

### Real-Time Analytics
- **Streaming Pipelines**: Kafka consumers, stream transformations, windowing
- **Near Real-Time**: Micro-batch processing, 1-5 minute latency
- **Real-Time Dashboards**: Live updating dashboards, WebSocket connections
- **Event Processing**: Complex event processing, pattern detection
- **Stateful Streaming**: Aggregations, joins in streaming context

## Data Governance & Privacy

### Data Governance
- **Data Catalog**: Documenting datasets, owners, SLAs, business definitions
- **Access Control**: Column-level security, row-level security, dynamic masking
- **Data Classification**: PII, sensitive data, public data classification
- **Data Retention**: Retention policies, automated deletion, archival
- **Data Lineage**: Tracking data transformations, impact analysis

### Privacy Compliance
- **GDPR Compliance**: Right to access, right to erasure, data portability
- **PII Detection**: Automatically identifying personal data in datasets
- **Data Anonymization**: Hashing, masking, synthetic data generation
- **Consent Management**: Tracking user consent, respecting opt-outs
- **Data Minimization**: Collecting only necessary data, aggregating when possible

### Data Security
- **Encryption**: At rest and in transit, column-level encryption
- **Access Auditing**: Logging data access, query logs, user activity
- **Data Masking**: Masking PII in non-production environments
- **Secure Data Sharing**: Snowflake data sharing, data clean rooms
- **Key Management**: Managing encryption keys, rotation policies

## Analytics Use Cases

### Product Analytics
- **User Behavior Tracking**: Page views, clicks, feature usage
- **Funnel Analysis**: Conversion tracking, drop-off identification
- **Retention Analysis**: Cohort retention, churn prediction
- **Feature Adoption**: Measuring adoption of new features
- **Segmentation**: User segments based on behavior, demographics

### Marketing Analytics
- **Attribution Modeling**: Multi-touch attribution, first/last touch
- **Campaign Performance**: ROI analysis, channel effectiveness
- **Customer Acquisition Cost (CAC)**: Tracking acquisition costs by channel
- **Lifetime Value (LTV)**: Predicting customer lifetime value
- **Funnel Optimization**: A/B testing, conversion rate optimization

### Financial Analytics
- **Revenue Reporting**: MRR, ARR, revenue recognition
- **Churn Analysis**: Churn rate, churn reasons, retention strategies
- **Cohort Revenue**: Revenue by customer cohort
- **Unit Economics**: LTV/CAC ratio, payback period
- **Forecasting**: Revenue forecasting, growth projections

### Operational Analytics
- **System Performance**: Application metrics, database performance
- **Error Tracking**: Error rates, error types, root cause analysis
- **Resource Utilization**: CPU, memory, storage usage trends
- **SLA Monitoring**: Uptime, latency, error rate tracking
- **Alerting**: Threshold-based alerts, anomaly detection

## Debugging & Troubleshooting

### Pipeline Debugging
- **Task Failures**: Analyzing logs, identifying root causes, retrying failed tasks
- **Data Quality Issues**: Investigating bad data, tracing back to source
- **Performance Issues**: Profiling queries, identifying bottlenecks
- **Dependency Issues**: Resolving DAG dependency problems, circular dependencies
- **Resource Exhaustion**: Memory errors, disk space issues, connection pool exhaustion

### Query Optimization
- **Execution Plans**: Analyzing query plans, identifying expensive operations
- **Index Usage**: Ensuring queries use appropriate indexes
- **Join Strategies**: Choosing hash joins vs nested loops, broadcast joins
- **Partition Pruning**: Ensuring partitions are being filtered
- **Caching**: Leveraging query result caching, materialized views

### Data Validation
- **Schema Drift**: Detecting unexpected schema changes
- **Data Freshness**: Ensuring data is up-to-date, detecting stale data
- **Completeness Checks**: Ensuring all expected data is present
- **Consistency Checks**: Verifying data consistency across systems
- **Accuracy Checks**: Validating calculations, reconciliation with source systems

## Communication & Collaboration

### Stakeholder Management
- **Requirements Gathering**: Understanding business questions, translating to data models
- **Dashboard Design**: Collaborating with stakeholders on dashboard requirements
- **Data Literacy**: Educating stakeholders on how to interpret data
- **Expectation Setting**: Communicating data limitations, latency, accuracy
- **Impact Communication**: Explaining how data insights drive decisions

### Cross-Functional Collaboration
- **Product Teams**: Defining metrics, instrumentation, experimentation
- **Engineering Teams**: Integrating analytics events, API design for data extraction
- **Data Science Teams**: Feature engineering, model deployment, data pipelines
- **Executive Leadership**: High-level dashboards, strategic insights, data-driven decisions

### Technical Communication
- **Data Documentation**: Documenting data models, transformations, business logic
- **Runbooks**: Operational procedures, troubleshooting guides, on-call playbooks
- **Knowledge Sharing**: Data office hours, training sessions, internal blog posts
- **Code Review**: Reviewing SQL, Python code, dbt models for correctness and performance

## Continuous Improvement

### Performance Monitoring
- **Query Performance**: Tracking query latency, optimizing slow queries
- **Pipeline Performance**: Monitoring DAG run times, identifying bottlenecks
- **Cost Monitoring**: Tracking cloud data warehouse costs, optimizing spend
- **Data Freshness**: Ensuring SLAs are met, reducing latency
- **Data Quality**: Monitoring test pass rates, anomaly detection

### Platform Evolution
- **Technology Evaluation**: Assessing new tools, PoC development
- **Process Improvement**: Streamlining workflows, automation opportunities
- **Best Practices**: Establishing data engineering standards, style guides
- **Self-Service**: Building tools for analysts to self-serve on data
- **Platform Development**: Building internal data platforms, data catalogs

## Key Strengths Summary

The Data Intelligence specialist excels at:
- Building scalable, reliable data pipelines and infrastructure
- Designing optimal data warehouse schemas and models
- Creating insightful dashboards and analytics products
- Optimizing query and pipeline performance
- Implementing data quality and governance frameworks
- Enabling self-service analytics for stakeholders
- Translating business questions into data models and metrics
- Communicating data insights to technical and non-technical audiences
- Ensuring data privacy and compliance
- Continuously improving data platform capabilities

This role is ideal for data platform architecture, analytics engineering, dashboard development, data pipeline optimization, and enabling data-driven decision making across the organization.
